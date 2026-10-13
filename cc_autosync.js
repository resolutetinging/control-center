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
 * v3（2026-10-13，spec 3.3a 跨裝置防覆蓋）：
 *  - cc_sync.json 帶 _meta:{rev,device}；本機 cc_sync_rev / cc_device_id 為裝置本地 key（不上傳、不還原）
 *  - 開頁先查雲端 rev：相同→照舊；雲端較新且本機無修改→自動下載並重載一次；兩邊都改→衝突橫幅、停止自動上傳
 *  - 可見時每 5 分鐘＋回到前景重新檢查；quickSync 只在最近一次檢查判定「雲端未變」時才上傳
 *  - 任何檢查錯誤一律退回「不上傳、不下載、不打擾」
 */
(function () {
  'use strict';

  // ── 正向白名單：只有這些 key 可以上傳到 Gist ──────────────────────────
  const SAFE_STATIC_KEYS = new Set([
    // Refueler
    'refueler_v1', 'refueler_rm_state',
    // Guard
    'guard_settings_v1',
    // CC 主頁（cc_wp_v1 桌布刻意不同步，各裝置各自獨立設定，2026-07-21起排除）
    'cc_links_v2', 'cc_last_sync', 'cc_lab_projects',
    'cc_usage_stats', 'cc_cat_gif',
    // Oasis
    'oasis_keywords', 'oasis_saved', 'oasis_authors', 'oasis_cache', 'oasis_status',
    // Worship
    'worship_v1', 'worship_last',
    // Daily Optimizer（任務庫與設定）
    'tina_tasks_v3', 'tina_tasks_v2', 'tina_tasks',
    'optimizer_custom_locs', 'optimizer_custom_feels', 'optimizer_custom_cafs',
    'optimizer_jobsearch_mode',
    // SAS Hub / Sleep Dashboard
    'sas_sleep_latest', 'sas_combat', 'sas_combat_weighted', 'sas_combat_single',
    'sas_endurance', 'sas_dta', 'sas_pipe_review', 'sas_settings',
    'sas_weekly_recap', 'cc_energy_weights', 'sas_risk_flags',
    'sas_combat_date', 'sas_combat_weekday',
    // 08-04：sas_overload_log（配速燈近14筆過載記錄）原本漏排，換裝置/清storage會靜默歸零
    'sas_overload_log',
    // 08-05：sas_week_flags/sas_pace_flags（近7天燈/配速燈接Guard用）比照sas_risk_flags排入白名單，
    // 否則第二台裝置只開CC不開SAS Hub時，Guard永遠看不到長期負荷提示
    'sas_week_flags', 'sas_pace_flags',
    // Mental Dashboard
    'wellness_v5', 'mental_custom_emotions',
    // English Sandbox
    'es_idiom_lib', 'es_saved_phrases',
    // 09-16稽核發現：es_grammar_lib（09-08新增的文法追蹤收藏）漏排，換裝置/清storage會
    // 靜默遺失，比照sas_overload_log的補法排入白名單。es_auto_speak/es_round_target是
    // 單裝置偏好設定（自動播音開關/練習題數），比照cc_wp_v1桌布模式刻意不排入
    'es_grammar_lib',
    // Scratchpad（雜記收件匣）
    'cc_scratch_v1',
    // 未來發展四象限（career-matrix.html）
    'cc_career_v1',
    // 動態財務規劃（finance-planner.html）
    'cc_finance_v1',
    // External Me（life_tracker_v1）
    'lto_matrix',
    // WordVault 成人版＋Kids
    'wordvault_v1', 'wordvault_v1-kids', 'wvk_kids_profiles',
    'wordvault_reminder_days', 'wvk_parent_pwd',
    // AI Tracker 詞彙表/分類策展
    'custom_cats', 'gloss_cat', 'gloss_user_terms', 'gloss_hidden', 'gloss_hist_overrides',
    // NexusPortal
    'nexus_pb', 'nexus_ptm',
    // 每月安全回顧提醒（Dev Dashboard，08-18新增）
    'cc_review_git_history_ack',
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

  // v3：裝置本地 key 與 _meta 永不上傳、永不還原（即使日後誤加進白名單也擋下）
  const META_KEY = '_meta';
  const DEVICE_LOCAL_KEYS = ['cc_sync_rev', 'cc_device_id', 'cc_auto_hash', 'cc_auto_at', 'cc_big_manifest'];
  const CHECK_INTERVAL_MS = 5 * 60 * 1000;

  function isSafeKey(k) {
    if (typeof k !== 'string' || k === META_KEY || DEVICE_LOCAL_KEYS.indexOf(k) >= 0) return false;
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

  // 僅供本機測試覆寫（指向 mock Gist）；正式環境不設定時固定 api.github.com
  function apiBase() {
    try {
      const b = window.__CC_GIST_API_BASE;
      if (typeof b === 'string' && /^https?:\/\//.test(b)) return b.replace(/\/+$/, '');
    } catch (e) {}
    return 'https://api.github.com';
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function deviceId() {
    let id = lsGet('cc_device_id');
    if (!id) {
      id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      lsSet('cc_device_id', id);
    }
    return id;
  }
  function localRev() {
    const n = parseInt(lsGet('cc_sync_rev') || '0', 10);
    return (isFinite(n) && n > 0) ? n : 0;
  }
  // 本機是否有未上傳修改：沿用全量同步的快照 hash
  function hasLocalChanges() { return snapHash(buildSnapshot()) !== lsGet('cc_auto_hash'); }
  function metaOf(snap) {
    const m = snap && snap[META_KEY];
    if (!m || typeof m !== 'object') return { rev: 0, device: '' }; // 無 _meta（升級前資料）視為 rev 0
    const r = Number(m.rev);
    return { rev: (isFinite(r) && r > 0) ? r : 0, device: typeof m.device === 'string' ? m.device : '' };
  }
  // 雲端是否比本機新（自己這台裝置上傳的不算，順手對齊本機 rev，涵蓋 keepalive 回應沒被處理的情況）
  function cloudIsNewer(meta) {
    if (!(meta.rev > localRev())) return false;
    if (meta.device && meta.device === deviceId()) { lsSet('cc_sync_rev', String(meta.rev)); return false; }
    return true;
  }

  /**
   * 讀取雲端 cc_sync.json（含 truncated → raw_url）。
   * strict=true（首頁 ↓／下載用）：內容缺失或格式錯誤即拋錯；
   * strict=false（上傳前／開頁檢查）：格式錯誤時 snap=null、rev 視為 0（沿用舊行為，允許上傳修復）。
   * 網路錯誤、HTTP 錯誤一律拋錯（呼叫端據此「不上傳、不下載」）。
   */
  async function fetchCloud(strict) {
    const c = creds();
    if (!c) throw new Error('尚未設定 PAT / Gist ID');
    let r;
    try { r = await gistFetch(c, 'GET'); }
    catch (fe) { throw new Error('網路錯誤 ' + (fe && fe.message)); }
    if (!r.ok) throw new Error('GitHub ' + r.status + (r.status === 401 ? '（PAT 無效）' : r.status === 404 ? '（Gist ID 錯誤）' : ''));
    const j = await r.json();
    const fileData = j && j.files ? j.files['cc_sync.json'] : null;
    if (!fileData) {
      if (strict) throw new Error('Gist 內找不到 cc_sync.json');
      return { j: j, snap: null, meta: { rev: 0, device: '' } };
    }
    let content = fileData.content;
    if (fileData.truncated) {
      let rawR;
      try { rawR = await fetch(fileData.raw_url); }
      catch (fe) { throw new Error('讀取完整內容失敗 ' + (fe && fe.message)); }
      if (!rawR.ok) throw new Error('raw 內容取得失敗 ' + rawR.status);
      content = await rawR.text();
    }
    let snap = null;
    try { snap = JSON.parse(content); } catch (e) {
      if (strict) throw new Error('資料格式錯誤：' + e.message);
      snap = null;
    }
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) {
      if (strict) throw new Error('資料結構錯誤，請重新 Upload');
      return { j: j, snap: null, meta: { rev: 0, device: '' } };
    }
    return { j: j, snap: snap, meta: metaOf(snap) };
  }

  function gistFetch(c, method, body, keepalive) {
    return fetch(apiBase() + '/gists/' + c.gid, {
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
  async function uploadFull(opts) {
    const c = creds();
    if (!c) throw new Error('尚未設定 PAT / Gist ID');
    if (_fullInFlight) throw new Error('全量同步進行中');
    _fullInFlight = true;
    try {
      return await _uploadFullInner(c, opts || {});
    } finally {
      _fullInFlight = false;
    }
  }
  async function _uploadFullInner(c, opts) {
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
    // 1) 取現有檔案清單（供清理舊分塊）＋ v3：先查雲端版本，雲端較新時不覆蓋（opts.force 除外）
    const cloud = await fetchCloud(false);
    const gj = cloud.j || {};
    const existing = Object.keys(gj.files || {});
    _lastCloudRev = cloud.meta.rev;
    if (!opts.force && cloudIsNewer(cloud.meta)) {
      let err;
      if (hasLocalChanges()) {
        setState('conflict');
        showBanner(true);
        err = new Error('另一台裝置有較新的雲端資料，已暫停上傳（見頁面上方提示）');
        err.ccConflict = true;
      } else {
        setState('newer');
        err = new Error('雲端有較新資料，請先下載再上傳');
        err.ccNewer = true;
      }
      throw err;
    }
    const rev = Math.max(Date.now(), cloud.meta.rev + 1, localRev() + 1);
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
    smallWithManifest[META_KEY] = { rev: rev, device: deviceId() };
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
    lsSet('cc_sync_rev', String(rev));
    _lastCloudRev = rev;
    markFullSynced(hash);
    setState('same');
    hideBanner();
    return { keyCount: Object.keys(full).length, bigKeys: Object.keys(big), skippedBig: skippedBig, deletedStale: deletedStale };
  }

  // ── v3 雲端版本狀態 ──────────────────────────────────────────────
  // unknown：尚未檢查｜same：雲端未變（可自動上傳）｜newer：雲端較新、本機無修改｜conflict：兩邊都改｜error：檢查失敗
  let _state = 'unknown';
  let _lastCloudRev = 0;
  let _checking = false;
  let _bannerSnoozed = false;
  function setState(s) {
    _state = s;
    if (s === 'same') _bannerSnoozed = false;
  }

  // ── 下載還原核心（首頁 ↓ 與自動下載共用，規則與 v2 首頁 ↓ 完全一致） ──
  // 回傳 { skipped:[key], incomplete:[key], bigRestored:n }；不刪除本機任何 key，只覆蓋白名單內的
  async function applySnapshot(j, snap, onProgress) {
    const skipped = [];
    const IDB_KEYS = window.CC_IDB_IMAGE_KEYS || [];
    // 已遷移到 IndexedDB 的圖片類 key：還原時寫回 IndexedDB 而非 localStorage
    async function restoreOne(k, v) {
      if (IDB_KEYS.includes(k) && window.ccStore) {
        try { await window.ccStore.put(k, v); localStorage.removeItem(k); localStorage.setItem(k + '__idb', '1'); return true; }
        catch (e) { console.warn('[Sync] 還原到 IndexedDB 失敗，改存 localStorage：', k, e); }
      }
      try { localStorage.setItem(k, v); return true; }
      catch (e) { if (e.name === 'QuotaExceededError') { return false; } throw e; }
    }
    for (const [k, v] of Object.entries(snap)) {
      // cc_wp_v1（桌布）刻意排除還原：各裝置桌布各自獨立，不隨同步覆蓋（2026-07-21起）
      if (v == null || k === MANIFEST_KEY || k === META_KEY || k === 'cc_wp_v1') continue;
      // 白名單防護（含裝置本地 key 排除）
      if (!isSafeKey(k)) continue;
      // 第二道：值必須是字串，且不得夾帶憑證
      if (typeof v !== 'string' || /(ghp_|github_pat_|gho_|gsk_)[A-Za-z0-9_]{20,}/.test(v)) continue;
      const ok = await restoreOne(k, v);
      if (!ok) skipped.push(k);
    }
    // 大型 key 分塊還原（cc_big__ 檔案，由 __cc_manifest 索引）
    const incomplete = []; let bigRestored = 0;
    let manifest = {};
    try { manifest = JSON.parse(snap[MANIFEST_KEY] || '{}'); } catch (e) { manifest = {}; }
    if (!manifest || typeof manifest !== 'object') manifest = {};
    for (const [bk, info] of Object.entries(manifest)) {
      if (!isSafeKey(bk) || bk === 'cc_wp_v1') continue;
      if (!info || !Array.isArray(info.names)) { incomplete.push(bk); continue; }
      if (typeof onProgress === 'function') { try { onProgress(bk); } catch (e) {} }
      let val = '', ok = true;
      for (const name of info.names) {
        const f = j && j.files ? j.files[name] : null;
        if (!f) { ok = false; break; }
        let c = f.content;
        if (f.truncated) {
          try { const rr = await fetch(f.raw_url); if (!rr.ok) throw 0; c = await rr.text(); }
          catch (e) { ok = false; break; }
        }
        val += c;
      }
      if (!ok) { incomplete.push(bk); continue; }
      if (typeof val !== 'string' || /(ghp_|github_pat_|gho_|gsk_)[A-Za-z0-9_]{20,}/.test(val)) continue;
      const saved = await restoreOne(bk, val);
      if (saved) bigRestored++; else skipped.push(bk);
    }
    if (bigRestored) try { localStorage.setItem('cc_big_manifest', snap[MANIFEST_KEY] || '{}'); } catch (e) {}
    return { skipped: skipped, incomplete: incomplete, bigRestored: bigRestored };
  }

  // 下載完成後：本機 rev 對齊雲端、hash 設為下載後狀態（之後不被誤判為有修改）
  function markDownloaded(meta) {
    const r = meta && meta.rev > 0 ? meta.rev : 0;
    if (r > 0) lsSet('cc_sync_rev', String(r));
    _lastCloudRev = r;
    lsSet('cc_auto_hash', snapHash(buildSnapshot()));
    setState('same');
    hideBanner();
  }

  // auto=true：自動下載（重驗條件＋防重載迴圈）；auto=false：使用者在橫幅按「下載雲端版」
  async function downloadAndReload(auto, cloud) {
    if (!cloud) cloud = await fetchCloud(true);
    if (!cloud.snap) throw new Error('Gist 內找不到 cc_sync.json');
    if (auto) {
      let guard = null;
      try { guard = sessionStorage.getItem('cc_sync_dl_rev'); } catch (e) {}
      if (guard === String(cloud.meta.rev)) { setState('error'); return false; } // 同一 rev 已自動下載過一次，避免重載迴圈
      if (hasLocalChanges()) { setState('conflict'); showBanner(false); return false; }
    }
    await applySnapshot(cloud.j, cloud.snap);
    markDownloaded(cloud.meta);
    try { sessionStorage.setItem('cc_sync_dl_rev', String(cloud.meta.rev)); } catch (e) {}
    try { window.location.reload(); } catch (e) {}
    return true;
  }

  // ── 開頁／前景／定時：檢查雲端版本 ────────────────────────────────
  async function checkCloud(isOpen) {
    if (!creds() || _checking || _fullInFlight) return;
    _checking = true;
    try {
      const cloud = await fetchCloud(false);
      _lastCloudRev = cloud.meta.rev;
      if (!cloudIsNewer(cloud.meta)) {
        setState('same');
        hideBanner();
        if (isOpen) maybeAutoFull();
        return;
      }
      if (hasLocalChanges()) { setState('conflict'); showBanner(false); return; }
      setState('newer');
      await downloadAndReload(true, cloud);
    } catch (e) {
      setState('error'); // 不上傳、不下載、不打擾
    } finally {
      _checking = false;
    }
  }

  // ── 衝突橫幅（頁面頂端固定；不用 alert/confirm） ────────────────────
  const BANNER_ID = 'cc-sync-conflict';
  function hideBanner() {
    try { const el = document.getElementById(BANNER_ID); if (el) el.remove(); } catch (e) {}
  }
  function showBanner(fromManual) {
    try {
      if (_bannerSnoozed && !fromManual) return;
      if (!document.body) {
        document.addEventListener('DOMContentLoaded', function () { showBanner(fromManual); }, { once: true });
        return;
      }
      if (document.getElementById(BANNER_ID)) return;
      const bar = document.createElement('div');
      bar.id = BANNER_ID;
      bar.setAttribute('role', 'alert');
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483000;display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 16px;background:#f4ede1;color:#3b372f;border-bottom:1px solid #d6cab6;box-shadow:0 2px 10px rgba(60,50,35,.12);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;font-style:normal;box-sizing:border-box';
      const msg = document.createElement('span');
      msg.style.cssText = 'flex:1 1 260px;font-style:normal';
      msg.textContent = '另一台裝置有較新的雲端資料，這台也有未上傳修改';
      bar.appendChild(msg);
      const btnBase = 'font:inherit;font-style:normal;font-size:13px;padding:6px 12px;border-radius:8px;cursor:pointer;';
      function mk(id, label, style, fn) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('data-act', id);
        b.textContent = label;
        b.style.cssText = btnBase + style;
        b.addEventListener('click', fn);
        bar.appendChild(b);
        return b;
      }
      function busy(t) { msg.textContent = t; bar.querySelectorAll('button').forEach(function (x) { x.disabled = true; }); }
      function fail(t) { msg.textContent = t; bar.querySelectorAll('button').forEach(function (x) { x.disabled = false; }); }
      mk('download', '下載雲端版（捨棄這台修改）', 'background:#5b7891;color:#fff;border:1px solid #5b7891;', function () {
        busy('下載雲端資料中…');
        downloadAndReload(false).catch(function (e) { fail('下載失敗：' + ((e && e.message) || '未知原因') + '，請稍後再試'); });
      });
      mk('upload', '上傳這台版本（覆蓋雲端）', 'background:transparent;color:#3b372f;border:1px solid #b6a990;', function () {
        busy('上傳中…');
        uploadFull({ force: true }).then(function () { hideBanner(); })
          .catch(function (e) { fail('上傳失敗：' + ((e && e.message) || '未知原因') + '，請稍後再試'); });
      });
      mk('later', '稍後', 'background:transparent;color:#6b6457;border:1px solid transparent;', function () {
        _bannerSnoozed = true; // 本頁不再自動跳出；仍維持停止自動上傳
        hideBanner();
      });
      document.body.appendChild(bar);
    } catch (e) {}
  }

  // ── 開頁自動全量同步（hash 變更＋10 分鐘節流；僅在檢查判定雲端未變後呼叫） ──
  function maybeAutoFull() {
    try {
      const c = creds();
      if (!c || _state !== 'same') return;
      const last = parseInt(localStorage.getItem('cc_auto_at') || '0', 10);
      if (Date.now() - last < AUTO_MIN_GAP_MS) return;
      const hash = snapHash(buildSnapshot());
      if (hash === localStorage.getItem('cc_auto_hash')) return;
      uploadFull().catch(function (e) { console.warn('[cc_autosync] 自動全量同步略過：', e.message); });
    } catch (e) {}
  }

  // ── 合蓋/離頁：輕量同步（僅小型 key；keepalive 限 60KB） ─────────────
  let _fired = false;
  function quickSync() {
    try {
      if (_fired) return;
      if (_fullInFlight) return; // 全量同步進行中，避免舊 manifest 蓋掉新索引（競態防護）
      if (_state !== 'same') return; // v3：最近一次檢查未判定「雲端未變」（含衝突、檢查失敗、尚未檢查）→ 不上傳
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
      const rev = Math.max(Date.now(), _lastCloudRev + 1, localRev() + 1);
      small[META_KEY] = { rev: rev, device: deviceId() };
      const body = { files: { 'cc_sync.json': { content: JSON.stringify(small) } } };
      const useKeepalive = JSON.stringify(body).length < KEEPALIVE_LIMIT;
      gistFetch(c, 'PATCH', body, useKeepalive)
        .then(function (r) {
          if (r.ok) { stampLastSync(); lsSet('cc_sync_rev', String(rev)); _lastCloudRev = rev; }
        }) // 輕量同步不更新 cc_auto_at/hash（見 markFullSynced 註解）
        .catch(function () {});
    } catch (e) {}
  }

  let _lastVisibleCheck = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { quickSync(); return; }
    // 回到前景：重新檢查（10 秒內不重複）
    if (Date.now() - _lastVisibleCheck < 10000) return;
    _lastVisibleCheck = Date.now();
    checkCloud(false);
  });
  window.addEventListener('pagehide', quickSync);

  // 開頁檢查（取代 v2 的 8 秒後直接 maybeAutoFull）
  setTimeout(function () { checkCloud(true); }, 1500);
  // 頁面可見時每 5 分鐘重新檢查
  setInterval(function () { if (!document.hidden) checkCloud(false); }, CHECK_INTERVAL_MS);

  // 供 CC 首頁手動同步按鈕共用同一套核心（強制上傳、無節流）
  window.ccSyncCore = {
    buildSnapshot: buildSnapshot, uploadFull: uploadFull, MANIFEST_KEY: MANIFEST_KEY, isSafeKey: isSafeKey,
    fetchCloud: fetchCloud, applySnapshot: applySnapshot, markDownloaded: markDownloaded
  };
})();
