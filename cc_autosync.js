/**
 * cc_autosync.js v2 — Control Center 全量自動同步
 * 觸發：開頁 8 秒後（全量，含大型 key 分塊）＋ 合蓋/切換 App/離頁（輕量，僅小型 key）
 * 使用方式：各頁面 </body> 前加 <script src="cc_autosync.js"></script>
 *
 * 安全機制：正向白名單（只有明確列出的生活數據 key 才會上傳，憑證類 key 不列入白名單，物理隔離）
 * v2 修正（2026-07-06 B 階段）：
 *  1. keepalive fetch 有 64KB body 上限，舊版全量快照必超標 → 自動同步實際從未成功。
 *     改為開頁時走一般 fetch 全量上傳；合蓋時只送小 body（<60KB 才用 keepalive）。
 *  2. 超過 200,000 字元的大型 key（base64 圖片等）不再靜默丟棄：
 *     分塊存成 cc_big__<key>__<ts>__<i>of<n> 檔案，manifest 記在 cc_sync.json 的 __cc_manifest。
 *  3. cc_last_sync 改為上傳「成功後」才寫入（舊版先寫造成假同步時間戳）。
 *  4. 白名單補齊備份體檢（audit_backup_status_260706）點名的漏網 key。
 */
(function () {
  'use strict';

  // ── 正向白名單：只有這些 key 可以上傳到 Gist ──────────────────────────
  const SAFE_STATIC_KEYS = new Set([
    // Refueler
    'refueler_v1', 'refueler_rm_state',
    // Guard
    'guard_settings_v1',
    // CC 主頁
    'cc_links_v2', 'cc_wp_v1', 'cc_linkedin_v2', 'cc_last_sync', 'cc_lab_projects',
    'cc_usage_stats',
    // Oasis
    'oasis_keywords', 'oasis_saved', 'oasis_authors', 'oasis_cache', 'oasis_status',
    // Worship
    'worship_v1', 'worship_last',
    // Daily Optimizer（任務庫與設定）
    'tina_tasks_v3', 'tina_tasks_v2', 'tina_tasks',
    'optimizer_custom_locs', 'optimizer_custom_feels', 'optimizer_custom_cafs',
    // SAS Hub / Sleep Dashboard
    'sas_sleep_latest', 'sas_combat', 'sas_combat_weighted', 'sas_combat_single',
    'sas_endurance', 'sas_dta', 'sas_pipe_review', 'sas_settings',
    'sas_weekly_recap', 'cc_energy_weights',
    // Mental Dashboard
    'wellness_v5', 'md_card_st', 'md_last_view', 'mental_custom_emotions',
    // Astro Bot
    'astro_settings', 'astro_vedic_images', 'astro_myself', 'astro_forecast',
    'astro_chat', 'astro_cc_brief',
    // English Sandbox
    'es_idiom_lib', 'es_saved_phrases',
    // External Me（life_tracker_v1）
    'lto_matrix',
    // WordVault 成人版＋Kids
    'wordvault_v1', 'wordvault_v1-kids', 'wvk_kids_profiles',
    // AI Tracker 詞彙表/分類策展
    'custom_cats', 'gloss_cat', 'gloss_user_terms', 'gloss_hidden', 'gloss_hist_overrides',
  ]);

  // 動態 key 前綴白名單（每日覆盤 / AI Tracker 筆記 / Guard 靜默）
  const SAFE_PREFIXES = [
    'review_',       // Daily Optimizer 每日覆盤 review_YYYY-MM-DD
    'note_',         // AI Tracker 今日筆記 note_YYYY-MM-DD
    'guard_snooze_', // Guard 今日靜默 guard_snooze_YYYY-MM-DD
  ];

  // 變更偵測時忽略的高頻噪音 key（仍會被上傳，只是不觸發同步）
  const VOLATILE_KEYS = new Set(['cc_last_sync', 'cc_usage_stats', 'cc_quota_stat', 'cc_quota_ack']);

  const BIG_LIMIT = 200000;      // 超過此長度的 key 走分塊
  const CHUNK_SIZE = 700000;     // 單一分塊檔上限（<1MB，避免 gist API 讀取截斷）
  const KEEPALIVE_LIMIT = 60000; // keepalive body 上限（瀏覽器硬限 64KB，留餘裕）
  const AUTO_MIN_GAP_MS = 10 * 60 * 1000; // 開頁自動同步節流：10 分鐘
  const MANIFEST_KEY = '__cc_manifest';
  const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

  function isSafeKey(k) {
    if (SAFE_STATIC_KEYS.has(k)) return true;
    for (const prefix of SAFE_PREFIXES) {
      if (k.startsWith(prefix)) return true;
    }
    return false;
  }

  // 保險層：即使某個 key 意外混入白名單，值中若含憑證格式字串也阻擋
  const PAT_RE = /ghp_[A-Za-z0-9]{10,}|ghs_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|gsk_[A-Za-z0-9]{10,}/;

  function creds() {
    const pat = (localStorage.getItem('gh_pat') || '').trim();
    const gid = (localStorage.getItem('gist_id') || '').replace(/\s/g, '');
    return (pat && gid) ? { pat: pat, gid: gid } : null;
  }

  function buildSnapshot() {
    const snap = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!isSafeKey(k)) continue;
      const v = localStorage.getItem(k) || '';
      if (PAT_RE.test(v)) continue;
      snap[k] = v;
    }
    return snap;
  }

  // 圖片類 key 已搬到 IndexedDB（cc_store.js），localStorage 只剩 __idb 索引，掃不到真正內容。
  // 全量上傳前把這些 key 的實際內容從 IndexedDB 讀回來，合併進快照，走原本的大 key 分塊機制。
  // 只用在 uploadFull（本來就是 async），不影響 quickSync/maybeAutoFull 的同步 hash 判斷邏輯。
  async function mergeMigratedKeys(snap) {
    const merged = Object.assign({}, snap);
    if (!window.ccStore) return merged; // 此頁未載入 cc_store.js，維持原樣（不中斷備份）
    const idbKeys = window.CC_IDB_IMAGE_KEYS || [];
    for (const k of idbKeys) {
      if (!isSafeKey(k)) continue;
      try {
        const v = await window.ccStore.get(k);
        if (v != null && !PAT_RE.test(v)) merged[k] = v;
      } catch (e) { /* 讀取失敗就保留 snap 原值（可能是 localStorage 尚未遷移完的舊值） */ }
    }
    return merged;
  }

  // djb2 —— 對快照（排除噪音 key）算變更指紋
  function snapHash(snap) {
    let h = 5381;
    const keys = Object.keys(snap).filter(function (k) { return !VOLATILE_KEYS.has(k); }).sort();
    for (let i = 0; i < keys.length; i++) {
      const s = keys[i] + '' + snap[keys[i]] + '';
      for (let j = 0; j < s.length; j++) h = ((h << 5) + h + s.charCodeAt(j)) | 0;
    }
    return String(h);
  }

  function gistFetch(c, method, body, keepalive) {
    return fetch('https://api.github.com/gists/' + c.gid, {
      method: method,
      headers: {
        'Authorization': 'Bearer ' + c.pat,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json'
      },
      body: body ? JSON.stringify(body) : undefined,
      keepalive: !!keepalive
    });
  }

  function stampLastSync() {
    const nowStr = new Date().toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    try { localStorage.setItem('cc_last_sync', nowStr); } catch (e) {}
  }
  // 只有「全量」成功才更新 hash 與節流時間戳；輕量 quickSync 不碰，
  // 否則開頁 8 秒內離頁一次就會把全量同步節流掉（大型 key 永遠輪不到上傳）。
  function markFullSynced(hash) {
    stampLastSync();
    try {
      if (hash) localStorage.setItem('cc_auto_hash', hash);
      localStorage.setItem('cc_auto_at', String(Date.now()));
    } catch (e) {}
  }

  /**
   * 全量上傳（含大型 key 分塊）。回傳 Promise<summary>。
   * summary = { keyCount, bigKeys:[key...], skippedBig:[key...], deletedStale:n }
   * 流程：先傳分塊檔（每塊一個 PATCH，body 有界），最後傳 cc_sync.json＋manifest＋清理舊塊。
   */
  let _fullInFlight = false;
  async function uploadFull() {
    const c = creds();
    if (!c) throw new Error('尚未設定 PAT / Gist ID');
    if (_fullInFlight) throw new Error('全量同步進行中');
    _fullInFlight = true;
    try {
      return await _uploadFullInner(c);
    } finally {
      _fullInFlight = false;
    }
  }
  async function _uploadFullInner(c) {
    const syncSnap = buildSnapshot();
    const hash = snapHash(syncSnap); // 沿用 localStorage-only 快照算 hash，維持既有節流/變更偵測語意
    const full = await mergeMigratedKeys(syncSnap); // 上傳內容則補上已遷移到 IndexedDB 的圖片真實內容
    const small = {};
    const big = {};
    const skippedBig = [];
    for (const k in full) {
      if (full[k].length > BIG_LIMIT) {
        if (SAFE_NAME_RE.test(k)) big[k] = full[k];
        else skippedBig.push(k); // key 含 gist 檔名不允許的字元，無法分塊
      } else small[k] = full[k];
    }
    // 1) 取現有檔案清單（供清理舊分塊）
    const gr = await gistFetch(c, 'GET');
    if (!gr.ok) throw new Error('GitHub ' + gr.status + (gr.status === 401 ? '（PAT 無效）' : gr.status === 404 ? '（Gist ID 錯誤）' : ''));
    const gj = await gr.json();
    const existing = Object.keys(gj.files || {});
    // 2) 分塊並逐塊上傳
    const ts = Date.now().toString(36);
    const manifest = {};
    const newNames = new Set();
    for (const k in big) {
      const v = big[k];
      const n = Math.ceil(v.length / CHUNK_SIZE);
      const names = [];
      for (let i = 0; i < n; i++) {
        const name = 'cc_big__' + k + '__' + ts + '__' + (i + 1) + 'of' + n;
        names.push(name);
        newNames.add(name);
        const files = {};
        files[name] = { content: v.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE) };
        const pr = await gistFetch(c, 'PATCH', { files: files });
        if (!pr.ok) throw new Error('分塊上傳失敗（' + k + '）GitHub ' + pr.status);
      }
      manifest[k] = { n: n, names: names };
    }
    // 3) cc_sync.json（小型 key＋manifest）＋刪除不再引用的舊分塊
    // 保留上一代 manifest 引用的分塊（兩代保留）：即使競態下舊 manifest 蓋回 cc_sync.json，
    // 它指向的分塊檔仍在，下載端不會拿到「索引指向已刪檔案」的死索引。
    const protectedNames = new Set(newNames);
    try {
      const prev = JSON.parse(localStorage.getItem('cc_big_manifest') || '{}');
      for (const k in prev) {
        if (prev[k] && Array.isArray(prev[k].names)) prev[k].names.forEach(function (n) { protectedNames.add(n); });
      }
    } catch (e) {}
    const finalFiles = {};
    const smallWithManifest = Object.assign({}, small);
    smallWithManifest[MANIFEST_KEY] = JSON.stringify(manifest);
    finalFiles['cc_sync.json'] = { content: JSON.stringify(smallWithManifest) };
    let deletedStale = 0;
    for (const name of existing) {
      if (name.indexOf('cc_big__') === 0 && !protectedNames.has(name)) {
        finalFiles[name] = null;
        deletedStale++;
      }
    }
    const fr = await gistFetch(c, 'PATCH', { files: finalFiles });
    if (!fr.ok) throw new Error('GitHub ' + fr.status);
    try { localStorage.setItem('cc_big_manifest', JSON.stringify(manifest)); } catch (e) {}
    markFullSynced(hash);
    return { keyCount: Object.keys(full).length, bigKeys: Object.keys(big), skippedBig: skippedBig, deletedStale: deletedStale };
  }

  // ── 開頁自動全量同步（hash 變更＋10 分鐘節流） ──────────────────────
  function maybeAutoFull() {
    const c = creds();
    if (!c) return;
    const last = parseInt(localStorage.getItem('cc_auto_at') || '0', 10);
    if (Date.now() - last < AUTO_MIN_GAP_MS) return;
    const hash = snapHash(buildSnapshot());
    if (hash === localStorage.getItem('cc_auto_hash')) return;
    uploadFull().catch(function (e) { console.warn('[cc_autosync] 自動全量同步失敗：', e.message); });
  }

  // ── 合蓋/離頁：輕量同步（僅小型 key；keepalive 限 60KB） ─────────────
  let _fired = false;
  function quickSync() {
    if (_fired) return;
    if (_fullInFlight) return; // 全量同步進行中，避免舊 manifest 蓋掉新索引（競態防護）
    _fired = true;
    setTimeout(function () { _fired = false; }, 5000);
    const c = creds();
    if (!c) return;
    const full = buildSnapshot();
    const hash = snapHash(full);
    if (hash === localStorage.getItem('cc_auto_hash')) return;
    const small = {};
    for (const k in full) { if (full[k].length <= BIG_LIMIT) small[k] = full[k]; }
    // 保留上次全量上傳的 manifest，避免輕量同步蓋掉大型 key 的索引
    small[MANIFEST_KEY] = localStorage.getItem('cc_big_manifest') || '{}';
    const body = { files: { 'cc_sync.json': { content: JSON.stringify(small) } } };
    const useKeepalive = JSON.stringify(body).length < KEEPALIVE_LIMIT;
    gistFetch(c, 'PATCH', body, useKeepalive)
      .then(function (r) { if (r.ok) stampLastSync(); }) // 輕量同步不更新 cc_auto_at/hash（見 markFullSynced 註解）
      .catch(function () {});
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) quickSync();
  });
  window.addEventListener('pagehide', quickSync);

  setTimeout(maybeAutoFull, 8000);

  // 供 CC 首頁手動同步按鈕共用同一套核心（強制上傳、無節流）
  window.ccSyncCore = { buildSnapshot: buildSnapshot, uploadFull: uploadFull, MANIFEST_KEY: MANIFEST_KEY };
})();
