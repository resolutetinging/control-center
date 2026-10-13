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
 * v3.1（2026-10-13，驗證修正）：
 *  - 判定：雲端 _meta.rev ≠ 本機 rev 且 _meta.device ≠ 本機 → 別台改過；device 相同 → 對齊 rev；_meta 損壞且本機 rev≠0 → 未知來源改過
 *  - 所有成功上傳（全量／輕量／手動）都更新 rev 與 hash；輕量上傳先記 cc_sync_pending，下次檢查以雲端 device＋rev 確認
 *  - 輕量上傳只在「最近一次檢查開始 ≤60 秒且判定雲端未變」時進行；檢查開始即把狀態設回 unknown
 *  - 同裝置他分頁下載後（cc_sync_dl 旗標）本分頁停止上傳並重載；正在輸入時改顯示提示不自動重載
 *  - hash 排除狀態快照（oasis_status）、忽略 sas_*_flags 的 ts、refueler_v1 以 entries 集合比較
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
  // v3.1：oasis_status（Oasis 每次開頁重寫的統計快照，含 ts）亦排除，否則開 Oasis 就永遠被判「有修改」
  const VOLATILE_KEYS = new Set(['cc_last_sync', 'cc_usage_stats', 'cc_quota_stat', 'cc_quota_ack', 'oasis_status']);
  const LEGACY_VOLATILE_KEYS = new Set(['cc_last_sync', 'cc_usage_stats', 'cc_quota_stat', 'cc_quota_ack']); // v3.0 hash 相容比對用
  // 開頁會重寫 ts 的狀態型 key：比較時忽略 ts 欄位（SAS Hub 同源寫入；level/flags 變了仍算修改）
  const TS_STRIP_KEYS = new Set(['sas_risk_flags', 'sas_week_flags', 'sas_pace_flags']);
  const HASH_PREFIX = 'h2:';

  const BIG_LIMIT = 200000;      // 超過此長度的 key 走分塊
  const CHUNK_SIZE = 700000;     // 單一分塊檔上限（<1MB，避免 gist API 讀取截斷）
  const KEEPALIVE_LIMIT = 60000; // keepalive body 上限（瀏覽器硬限 64KB，留餘裕）
  const AUTO_MIN_GAP_MS = 10 * 60 * 1000; // 開頁自動同步節流：10 分鐘
  const MANIFEST_KEY = '__cc_manifest';
  const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

  // v3：裝置本地 key 與 _meta 永不上傳、永不還原（即使日後誤加進白名單也擋下）
  const META_KEY = '_meta';
  const DEVICE_LOCAL_KEYS = ['cc_sync_rev', 'cc_device_id', 'cc_auto_hash', 'cc_auto_at', 'cc_big_manifest',
    'cc_big_hash', 'cc_sync_pending', 'cc_sync_dl'];
  const CHECK_INTERVAL_MS = 5 * 60 * 1000;
  const FRESH_MS = 60 * 1000;     // 離頁輕量上傳：最近一次檢查（開始時間）須在 60 秒內
  const DIRTY_RECHECK_MS = 40 * 1000; // 有未上傳修改時，可見期間約每 40 秒重新檢查，讓離頁時檢查結果保持新鮮
  const TICK_MS = 15 * 1000;

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
  function djb2(h, s) {
    for (let j = 0; j < s.length; j++) h = ((h << 5) + h + s.charCodeAt(j)) | 0;
    return h;
  }
  function stableStr(v) {
    if (v === null || typeof v !== 'object') return String(JSON.stringify(v));
    if (Array.isArray(v)) return '[' + v.map(stableStr).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stableStr(v[k]); }).join(',') + '}';
  }
  // 比較用的正規化值（只影響 hash，不影響上傳內容）
  function canonVal(k, v) {
    try {
      if (TS_STRIP_KEYS.has(k)) {
        const o = JSON.parse(v);
        if (!o || typeof o !== 'object' || Array.isArray(o)) return v;
        const c = Object.assign({}, o); delete c.ts;
        return 'TS' + stableStr(c);
      }
      if (k === 'refueler_v1') {
        // Refueler 開頁自有 Gist 合併會重排 entries、正規化型別：以 entries 集合比較，內容相同即視為未修改
        const o = JSON.parse(v);
        if (!o || typeof o !== 'object' || !Array.isArray(o.entries)) return v;
        const out = []; // 完整多重集合（重複 id 不去重，避免第一筆不同就誤判相同）
        for (const e of o.entries) {
          if (!e || typeof e !== 'object') continue;
          const c = Object.assign({}, e);
          if (c.id != null) c.id = String(c.id);
          ['cafe', 'item', 'dessert'].forEach(function (f) { if (c[f] != null && typeof c[f] !== 'string') c[f] = String(c[f]); });
          ['coffeePrice', 'price', 'dessertPrice', 'amount'].forEach(function (f) { if (c[f] != null) { const n = Number(c[f]); c[f] = isFinite(n) ? n : 0; } });
          out.push(stableStr(c));
        }
        out.sort();
        return 'RF[' + out.join(',') + ']';
      }
    } catch (e) {}
    return v;
  }
  function snapHash(snap) {
    let h = 5381;
    const keys = Object.keys(snap).filter(function (k) { return !VOLATILE_KEYS.has(k); }).sort();
    for (let i = 0; i < keys.length; i++) h = djb2(h, keys[i] + '\u0001' + canonVal(keys[i], snap[keys[i]]) + '\u0002');
    return HASH_PREFIX + h;
  }
  // v3.0 的 hash（無前綴）：升級後第一次比對用，相符即換成新格式
  function legacyHash(snap) {
    let h = 5381;
    const keys = Object.keys(snap).filter(function (k) { return !LEGACY_VOLATILE_KEYS.has(k); }).sort();
    for (let i = 0; i < keys.length; i++) h = djb2(h, keys[i] + '\u0001' + snap[keys[i]] + '\u0002');
    return String(h);
  }
  // 大型 key（走分塊、輕量上傳不帶）的指紋：判斷輕量上傳後雲端是否已完整反映本機
  function bigHash(snap) {
    const big = {};
    for (const k in snap) { if (snap[k].length > BIG_LIMIT) big[k] = snap[k]; }
    return snapHash(big);
  }
  function hasData(snap) {
    for (const k in snap) { if (!VOLATILE_KEYS.has(k)) return true; }
    return false;
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
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  // 本機快照是否與「雲端已反映的狀態」一致：true／false；null＝從未同步（無 cc_auto_hash）
  function storedHashMatches(snap) {
    const stored = lsGet('cc_auto_hash');
    if (!stored) return null;
    if (stored.indexOf(HASH_PREFIX) === 0) return stored === snapHash(snap);
    if (stored === legacyHash(snap)) { lsSet('cc_auto_hash', snapHash(snap)); return true; } // v3.0 → v3.1 格式遷移
    return false;
  }
  // 本機是否有未上傳修改；全新／空裝置（從未同步且白名單 key 全空）視為無修改
  function hasLocalChanges() {
    const snap = buildSnapshot();
    const m = storedHashMatches(snap);
    if (m === null) return hasData(snap);
    return !m;
  }
  function metaOf(snap) {
    const m = snap && snap[META_KEY];
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { rev: 0, device: '', valid: false };
    const r = Number(m.rev);
    if (!(isFinite(r) && r > 0) || typeof m.device !== 'string' || !m.device) return { rev: 0, device: '', valid: false };
    const hist = Array.isArray(m.hist) ? m.hist.map(Number).filter(function (x) { return isFinite(x) && x > 0; }).slice(0, 8) : [];
    return { rev: r, device: m.device, valid: true, hist: hist };
  }
  // 上傳時寫入 _meta.hist：本次覆蓋前的雲端 rev 鏈（最多 8 個），讓先前上傳但沒收到回應的裝置能確認自己的上傳曾落地
  function histFrom(meta) {
    return (meta && meta.valid) ? [meta.rev].concat(meta.hist || []).slice(0, 8) : [];
  }
  function cloudHasData(snap) {
    if (!snap) return false;
    for (const k in snap) {
      if (k === META_KEY) continue;
      if (k === MANIFEST_KEY && (snap[k] === '{}' || !snap[k])) continue;
      return true;
    }
    return false;
  }
  function readPending() {
    try { const p = JSON.parse(lsGet('cc_sync_pending') || 'null'); return (p && typeof p === 'object') ? p : null; } catch (e) { return null; }
  }
  // 上傳確認成功（回應 ok，或下次檢查時雲端 device＝本機且 rev＝pending）：rev 與 hash 一起更新
  function confirmUpload(rev, hash) {
    lsSet('cc_sync_rev', String(rev));
    if (hash) lsSet('cc_auto_hash', hash);
    const p = readPending();
    if (p && Number(p.rev) === rev) lsDel('cc_sync_pending');
    _lastCloudRev = rev;
  }
  function settlePending(meta) {
    const p = readPending();
    if (!p) return;
    const pr = Number(p.rev);
    const landed = meta.valid && ((meta.device === deviceId() && pr === meta.rev) || (meta.hist || []).indexOf(pr) >= 0);
    if (landed) {
      // 雲端就是本機的 pending 版本，或後來的上傳是以它為基礎（hist 含 pending rev）→ 輕量上傳確實成功
      confirmUpload(pr, typeof p.hash === 'string' ? p.hash : '');
    } else if (!(Date.now() - Number(p.at || 0) < 30000)) {
      lsDel('cc_sync_pending'); // 上傳未落地（失敗或已被後續版本取代）
    }
  }
  /**
   * 雲端狀態分類：'same'（雲端未變，或是本裝置自己上傳的）｜'newer'（被別台或未知來源改過）
   * 只呼叫在 cloud 非 missing／corrupt 時。
   */
  function classifyCloud(cloud) {
    const meta = cloud.meta;
    const lr = localRev();
    if (!meta.valid) {
      if (!cloudHasData(cloud.snap)) return 'same';
      if (lr !== 0) return 'newer';                       // 本機同步過 rev，雲端卻沒有有效 _meta → 未知來源改過
      return hasData(buildSnapshot()) ? 'same' : 'newer'; // 升級前資料沿用舊行為；空裝置則下載
    }
    settlePending(meta);
    const lr2 = localRev();
    if (meta.rev === lr2) return 'same';
    if (meta.device === deviceId()) {
      // 同裝置（其他分頁或回應沒被處理的 keepalive）上傳的：對齊 rev
      if (meta.rev < lr2) lsSet('cc_auto_hash', HASH_PREFIX + 'resend'); // 雲端比本機記錄舊（自己的上傳遺失）→ 視為有修改，下次重傳
      lsSet('cc_sync_rev', String(meta.rev));
      return 'same';
    }
    return 'newer';
  }

  /**
   * 讀取雲端 cc_sync.json（含 truncated → raw_url）。
   * strict=true（首頁 ↓／下載用）：內容缺失或格式錯誤即拋錯；
   * strict=false（上傳前／開頁檢查）：找不到 cc_sync.json → missing:true；格式錯誤 → corrupt:true（snap=null）。
   *   自動檢查／自動上傳遇到 missing／corrupt 一律視為檢查失敗；僅手動上傳允許覆蓋修復。
   * 網路錯誤、HTTP 錯誤、回應缺 files 一律拋錯（呼叫端據此「不上傳、不下載」）。
   */
  async function fetchCloud(strict) {
    const c = creds();
    if (!c) throw new Error('尚未設定 PAT / Gist ID');
    let r;
    try { r = await gistFetch(c, 'GET'); }
    catch (fe) { throw new Error('網路錯誤 ' + (fe && fe.message)); }
    if (!r.ok) throw new Error('GitHub ' + r.status + (r.status === 401 ? '（PAT 無效）' : r.status === 404 ? '（Gist ID 錯誤）' : ''));
    const j = await r.json();
    if (!j || typeof j !== 'object' || !j.files || typeof j.files !== 'object') throw new Error('Gist 回應缺少 files');
    const fileData = j.files['cc_sync.json'];
    if (!fileData || typeof fileData !== 'object') {
      if (strict) throw new Error('Gist 內找不到 cc_sync.json');
      return { j: j, snap: null, meta: metaOf(null), missing: true };
    }
    let content = fileData.content;
    if (fileData.truncated) {
      if (typeof fileData.raw_url !== 'string' || !/^https?:\/\//.test(fileData.raw_url)) throw new Error('raw_url 缺漏');
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
      return { j: j, snap: null, meta: metaOf(null), corrupt: true };
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
  // 只有「全量」成功才更新節流時間戳 cc_auto_at；輕量 quickSync 不碰，
  // 否則開頁 8 秒內離頁一次就會把全量同步節流掉（大型 key 永遠輪不到上傳）。
  // （v3.1：hash 則由所有成功上傳路徑更新，見 confirmUpload）
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
  function staleError() {
    const err = new Error('資料已在其他分頁更新，請重新整理後再上傳');
    err.ccStale = true;
    return err;
  }
  async function _uploadFullInner(c, opts) {
    if (_tabStale) { showNotice('stale'); throw staleError(); } // 本分頁持有舊資料，任何上傳都擋下
    const syncSnap = buildSnapshot();
    if (opts.auto && !hasData(syncSnap)) throw new Error('本機無資料，略過自動上傳'); // 空裝置永不自動覆蓋雲端
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
    const checkStart = Date.now();
    const cloud = await fetchCloud(false);
    const gj = cloud.j || {};
    const existing = Object.keys(gj.files || {});
    if ((cloud.missing || cloud.corrupt) && opts.auto) throw new Error('雲端資料缺漏或格式錯誤，已暫停自動上傳');
    _lastCloudRev = cloud.meta.rev;
    // 手動上傳遇到雲端缺檔／格式錯誤：允許覆蓋修復（沿用 v2 行為）
    if (!opts.force && !cloud.missing && !cloud.corrupt && classifyCloud(cloud) === 'newer') {
      let err;
      if (hasLocalChanges()) {
        setState('conflict');
        showBanner(true);
        err = new Error('另一台裝置有較新的雲端資料，已暫停上傳（見頁面上方提示）');
        err.ccConflict = true;
      } else {
        setState('newer');
        showNotice('update');
        err = new Error('雲端有較新資料，請先更新（見頁面上方提示）');
        err.ccNewer = true;
      }
      throw err;
    }
    if (_tabStale) { showNotice('stale'); throw staleError(); }
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
    smallWithManifest[META_KEY] = { rev: rev, device: deviceId(), hist: histFrom(cloud.meta) };
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
    lsSet('cc_big_hash', bigHash(syncSnap));
    lsDel('cc_sync_pending'); // 較早的輕量上傳 pending 已被本次全量取代
    confirmUpload(rev, hash);
    _lastCloudMeta = { rev: rev, device: deviceId(), valid: true, hist: histFrom(cloud.meta) };
    markFullSynced(hash);
    setState('same');
    _lastSameAt = checkStart;
    hideBanner();
    hideNotice();
    return { keyCount: Object.keys(full).length, bigKeys: Object.keys(big), skippedBig: skippedBig, deletedStale: deletedStale };
  }

  // ── v3 雲端版本狀態 ──────────────────────────────────────────────
  // unknown：尚未檢查／檢查中｜same：雲端未變（可自動上傳）｜newer：雲端較新、本機無修改｜conflict：兩邊都改｜error：檢查失敗
  // stale：同裝置其他分頁已下載新資料，本分頁持有舊資料（停止一切上傳，等重新整理）
  let _state = 'unknown';
  let _lastCloudRev = 0;
  let _checking = false;
  let _bannerSnoozed = false;
  let _lastCheckStart = 0; // 最近一次檢查（含上傳前檢查）開始時間
  let _lastSameAt = 0;     // 最近一次判定「雲端未變」的那次檢查的開始時間
  let _tabStale = false;
  let _lastCloudMeta = null; // 最近一次判定「雲端未變」時的雲端 _meta（輕量上傳寫 hist 用）
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
      if (TS_STRIP_KEYS.has(k) && localTsNewer(k, v)) continue; // 本機計算較新的狀態旗標：保留本機（Guard 24 小時視窗靠 ts）
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

  function tsOf(v) {
    try { const o = JSON.parse(v); const t = o && typeof o === 'object' ? Number(o.ts) : NaN; return isFinite(t) ? t : -Infinity; }
    catch (e) { return -Infinity; }
  }
  // 逐 key 比 ts：本機值的 ts 嚴格較新才保留本機；本機無值或無法解析一律採雲端
  function localTsNewer(k, cloudVal) {
    const lv = lsGet(k);
    if (lv == null) return false;
    return tsOf(lv) > tsOf(cloudVal);
  }

  // 下載完成後：本機 rev 對齊雲端、hash 設為下載後狀態（之後不被誤判為有修改）
  function markDownloaded(meta) {
    const r = meta && meta.valid && meta.rev > 0 ? meta.rev : 0;
    lsSet('cc_sync_rev', String(r)); // 雲端無有效 _meta 時歸 0（升級前資料語意），避免下次又被判「未知來源改過」而重複下載
    _lastCloudRev = r;
    const snap = buildSnapshot();
    lsSet('cc_auto_hash', snapHash(snap));
    lsSet('cc_big_hash', bigHash(snap));
    lsDel('cc_sync_pending');
    lsSet('cc_sync_dl', String(r) + ':' + Date.now()); // 通知同裝置其他分頁：資料已被下載覆蓋
    setState('same');
    hideBanner();
    hideNotice();
  }

  // auto=true：自動下載（重驗條件＋防重載迴圈＋輸入保護）；auto=false：使用者在衝突橫幅按「下載雲端版」
  // userClick=true：使用者在「雲端有新資料」提示按〔立即更新〕（仍重驗本機修改，但不受輸入保護與重載防迴圈限制）
  async function downloadAndReload(auto, cloud, userClick) {
    if (_tabStale) { showNotice('stale'); return false; }
    if (!cloud) cloud = await fetchCloud(true);
    if (!cloud.snap) throw new Error('Gist 內找不到 cc_sync.json');
    const guardVal = cloud.meta.valid ? String(cloud.meta.rev) : 'nometa';
    if (auto) {
      if (!userClick) {
        let guard = null;
        try { guard = sessionStorage.getItem('cc_sync_dl_rev'); } catch (e) {}
        if (guard === guardVal) { setState('error'); return false; } // 同一版本已自動下載過一次，避免重載迴圈
      }
      if (hasLocalChanges()) { setState('conflict'); hideNotice(); showBanner(!!userClick); return false; }
      if (!userClick && isUserEditing()) { setState('newer'); showNotice('update'); return false; } // 正在輸入：不覆蓋、不重載
    }
    await applySnapshot(cloud.j, cloud.snap);
    markDownloaded(cloud.meta);
    try { sessionStorage.setItem('cc_sync_dl_rev', guardVal); } catch (e) {}
    try { window.location.reload(); } catch (e) {}
    return true;
  }

  // ── 開頁／前景／定時：檢查雲端版本 ────────────────────────────────
  async function checkCloud() {
    if (!creds() || _checking || _fullInFlight || _tabStale) return;
    _checking = true;
    const startedAt = Date.now();
    _lastCheckStart = startedAt;
    setState('unknown'); // 請求掛著時不可沿用舊結果（離頁輕量上傳會被擋下）
    try {
      const cloud = await fetchCloud(false);
      if (cloud.missing || cloud.corrupt) { setState('error'); return; } // 回應異常：不上傳、不下載
      _lastCloudRev = cloud.meta.rev;
      if (classifyCloud(cloud) === 'same') {
        setState('same');
        _lastSameAt = startedAt;
        _lastCloudMeta = cloud.meta;
        hideBanner();
        hideNotice();
        maybeAutoFull();
        return;
      }
      if (hasLocalChanges()) { setState('conflict'); hideNotice(); showBanner(false); return; }
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
      hideNotice();
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

  // ── 單鈕提示（雲端有新資料／其他分頁已更新；與衝突橫幅同樣式） ─────────
  const NOTICE_ID = 'cc-sync-notice';
  function hideNotice() {
    try { const el = document.getElementById(NOTICE_ID); if (el) el.remove(); } catch (e) {}
  }
  function showNotice(kind) {
    try {
      if (!document.body) {
        document.addEventListener('DOMContentLoaded', function () { showNotice(kind); }, { once: true });
        return;
      }
      const old = document.getElementById(NOTICE_ID);
      if (old && old.getAttribute('data-kind') === kind) return;
      if (old) old.remove();
      hideBanner();
      const bar = document.createElement('div');
      bar.id = NOTICE_ID;
      bar.setAttribute('role', 'status');
      bar.setAttribute('data-kind', kind);
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483000;display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 16px;background:#f4ede1;color:#3b372f;border-bottom:1px solid #d6cab6;box-shadow:0 2px 10px rgba(60,50,35,.12);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;font-style:normal;box-sizing:border-box';
      const msg = document.createElement('span');
      msg.style.cssText = 'flex:1 1 260px;font-style:normal';
      msg.textContent = kind === 'stale' ? '資料已在其他分頁更新，這個分頁的修改不會再儲存，請重新整理' : '雲端有新資料（另一台裝置更新過）';
      bar.appendChild(msg);
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-act', kind === 'stale' ? 'reload' : 'update');
      b.textContent = kind === 'stale' ? '立即重新整理' : '立即更新';
      b.style.cssText = 'font:inherit;font-style:normal;font-size:13px;padding:6px 12px;border-radius:8px;cursor:pointer;background:#5b7891;color:#fff;border:1px solid #5b7891;';
      b.addEventListener('click', function () {
        if (kind === 'stale') { try { window.location.reload(); } catch (e) {} return; }
        b.disabled = true;
        msg.textContent = '下載雲端資料中…';
        downloadAndReload(true, null, true).then(function (ok) { if (!ok) hideNotice(); })
          .catch(function (e) { b.disabled = false; msg.textContent = '更新失敗：' + ((e && e.message) || '未知原因') + '，請稍後再試'; });
      });
      bar.appendChild(b);
      document.body.appendChild(bar);
    } catch (e) {}
  }

  // ── 輸入保護：正在輸入或有未存的輸入值時，不自動覆蓋／重載 ─────────────
  const _touched = new Set();
  try {
    document.addEventListener('input', function (e) {
      try { const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) _touched.add(t); } catch (x) {}
    }, true);
  } catch (e) {}
  const NON_TEXT_INPUT = ['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden'];
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
    if (el.tagName === 'INPUT') return !el.readOnly && !el.disabled && NON_TEXT_INPUT.indexOf(String(el.type || 'text').toLowerCase()) < 0;
    return false;
  }
  function isUserEditing() {
    try {
      if (isEditable(document.activeElement)) return true;
      let dirty = false;
      _touched.forEach(function (el) {
        if (!el.isConnected) { _touched.delete(el); return; } // 頁面重新渲染後被替換＝已存檔
        if (el.value !== el.defaultValue) dirty = true;        // 打過字、值仍與渲染時不同＝可能未存
      });
      return dirty;
    } catch (e) { return true; } // 判斷不了就保守視為輸入中（不自動重載）
  }

  // ── 自動全量同步（hash 變更＋10 分鐘節流；僅在檢查判定雲端未變後呼叫） ──
  function maybeAutoFull() {
    try {
      const c = creds();
      if (!c || _state !== 'same' || _tabStale) return;
      const last = parseInt(localStorage.getItem('cc_auto_at') || '0', 10);
      if (Date.now() - last < AUTO_MIN_GAP_MS) return;
      const snap = buildSnapshot();
      if (!hasData(snap) || storedHashMatches(snap) === true) return;
      uploadFull({ auto: true }).catch(function (e) { console.warn('[cc_autosync] 自動全量同步略過：', e.message); });
    } catch (e) {}
  }

  // ── 合蓋/離頁：輕量同步（僅小型 key；keepalive 限 60KB） ─────────────
  let _fired = false;
  function quickSync() {
    try {
      if (_fired || _tabStale) return;
      if (_fullInFlight) return; // 全量同步進行中，避免舊 manifest 蓋掉新索引（競態防護）
      if (_state !== 'same') return; // 最近一次檢查未判定「雲端未變」（含檢查中、衝突、檢查失敗、尚未檢查）→ 不上傳
      if (!(Date.now() - _lastSameAt <= FRESH_MS)) return; // v3.1：檢查結果超過 60 秒不可沿用；資料留在本機，下次開頁檢查後再傳
      const c = creds();
      if (!c) return;
      const full = buildSnapshot();
      if (!hasData(full)) return;
      if (storedHashMatches(full) === true) return;
      _fired = true;
      setTimeout(function () { _fired = false; }, 5000);
      const hash = snapHash(full);
      const small = {}, bigNow = {};
      for (const k in full) { if (full[k].length <= BIG_LIMIT) small[k] = full[k]; else bigNow[k] = full[k]; }
      // 大型 key 與上次全量／下載時相同 → 上傳後雲端即完整反映本機，可更新 hash；否則保留「有修改」讓下次全量補傳
      const bh = lsGet('cc_big_hash');
      const bigSame = bh ? bh === snapHash(bigNow) : Object.keys(bigNow).length === 0;
      const pendHash = bigSame ? hash : '';
      // 保留上次全量上傳的 manifest，避免輕量同步蓋掉大型 key 的索引
      small[MANIFEST_KEY] = localStorage.getItem('cc_big_manifest') || '{}';
      const rev = Math.max(Date.now(), _lastCloudRev + 1, localRev() + 1);
      const hist = histFrom(_lastCloudMeta);
      small[META_KEY] = { rev: rev, device: deviceId(), hist: hist };
      const body = { files: { 'cc_sync.json': { content: JSON.stringify(small) } } };
      const useKeepalive = JSON.stringify(body).length < KEEPALIVE_LIMIT;
      // keepalive 回應可能永遠收不到（頁面已卸載）：先記 pending，下次檢查看到雲端 device＝本機且 rev＝pending 即判定成功
      lsSet('cc_sync_pending', JSON.stringify({ rev: rev, hash: pendHash, at: Date.now() }));
      gistFetch(c, 'PATCH', body, useKeepalive)
        .then(function (r) {
          if (r.ok) { // 輕量同步不更新 cc_auto_at（見 markFullSynced 註解）
            stampLastSync();
            confirmUpload(rev, pendHash);
            _lastCloudMeta = { rev: rev, device: deviceId(), valid: true, hist: hist };
          }
        })
        .catch(function () {});
    } catch (e) {}
  }

  // ── 同裝置其他分頁下載了新資料（cc_sync_dl 變更）→ 本分頁停止上傳並重載 ──
  // 正在輸入而不自動重載時：本分頁對白名單 key 的寫入一律略過（頁面記憶體裡是舊資料，
  // 存檔會把剛下載的新資料蓋回舊版，之後再被當成「本機修改」上傳）
  function guardStaleWrites() {
    try {
      const proto = Storage.prototype;
      if (proto.setItem && proto.setItem.__ccStaleGuard) return;
      const origSet = proto.setItem, origDel = proto.removeItem;
      const blocked = function (st, k) {
        if (!_tabStale || st !== window.localStorage) return false;
        const key = String(k);
        if (!isSafeKey(key) || VOLATILE_KEYS.has(key)) return false;
        showNotice('stale');
        try { console.warn('[cc_autosync] 本分頁資料已過期，略過寫入：' + key); } catch (e) {}
        return true;
      };
      const wSet = function (k, v) { if (blocked(this, k)) return; return origSet.apply(this, arguments); };
      const wDel = function (k) { if (blocked(this, k)) return; return origDel.apply(this, arguments); };
      wSet.__ccStaleGuard = true;
      proto.setItem = wSet;
      proto.removeItem = wDel;
    } catch (e) {}
  }
  window.addEventListener('storage', function (e) {
    try {
      if (e.key !== 'cc_sync_dl' || !e.newValue || e.newValue === e.oldValue) return;
      _tabStale = true;
      setState('stale');
      hideBanner();
      try { window.dispatchEvent(new CustomEvent('cc-sync-stale')); } catch (x2) {}
      if (isUserEditing()) { guardStaleWrites(); showNotice('stale'); }
      else { guardStaleWrites(); window.location.reload(); }
    } catch (x) {}
  });

  let _lastVisibleCheck = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { quickSync(); return; }
    // 回到前景：重新檢查（10 秒內不重複）
    if (Date.now() - _lastVisibleCheck < 10000) return;
    _lastVisibleCheck = Date.now();
    checkCloud();
  });
  window.addEventListener('pagehide', quickSync);

  // 開頁檢查（取代 v2 的 8 秒後直接 maybeAutoFull）
  setTimeout(function () { checkCloud(); }, 1500);
  // 頁面可見時：每 5 分鐘重新檢查；有未上傳修改時約每 40 秒檢查一次（讓離頁輕量上傳有新鮮的檢查結果可用）
  setInterval(function () {
    try {
      if (document.hidden || _checking || _tabStale || !creds()) return;
      const age = Date.now() - _lastCheckStart;
      if (age >= CHECK_INTERVAL_MS || (age >= DIRTY_RECHECK_MS && _state === 'same' && hasLocalChanges())) checkCloud();
    } catch (e) {}
  }, TICK_MS);

  // 供 CC 首頁手動同步按鈕共用同一套核心（強制上傳、無節流）
  window.ccSyncCore = {
    buildSnapshot: buildSnapshot, uploadFull: uploadFull, MANIFEST_KEY: MANIFEST_KEY, isSafeKey: isSafeKey,
    fetchCloud: fetchCloud, applySnapshot: applySnapshot, markDownloaded: markDownloaded, snapHash: snapHash,
    isStaleTab: function () { return _tabStale; }
  };
})();
