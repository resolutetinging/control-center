/**
 * cc_track.js — 使用頻率追蹤 + localStorage 配額預警（唯一事實來源，勿在各頁複製）
 *
 * 用途：累積各 App 前景停留時間，寫入 localStorage 'cc_usage_stats'，
 *       供 Control Center 首頁 Dev Dashboard「使用頻率」讀取。
 *       同時偵測 localStorage 總用量，接近同源 ~5MB 上限時提醒使用者清理。
 *
 * 使用方式：各頁面 </body> 前加：
 *   <script src="cc_track.js" data-cc-key="xxx" data-cc-label="顯示名稱"></script>
 * （同 repo 用相對路徑 "cc_track.js"，跨 repo 用絕對網址
 *   "https://resolutetinging.github.io/control-center/cc_track.js"）
 *
 * 若未提供 data-cc-key / data-cc-label，fallback 使用 location.pathname。
 *
 * 修改請只改這一份檔案；12+ 個頁面共用同一份邏輯，嚴禁複製貼上到各頁。
 */
(function () {
  'use strict';

  // ── 使用頻率追蹤 ──────────────────────────────────────────────
  var _script = document.currentScript;
  var _ccKey = (_script && _script.dataset && _script.dataset.ccKey) || location.pathname;
  var _ccLabel = (_script && _script.dataset && _script.dataset.ccLabel) || location.pathname;

  var _ccStart = Date.now(), _ccActive = (document.visibilityState !== 'hidden');
  function _ccFlush() {
    if (!_ccActive) return;
    var elapsed = Date.now() - _ccStart;
    if (elapsed < 1000) return;
    try {
      var stats = JSON.parse(localStorage.getItem('cc_usage_stats') || '{}');
      if (!stats[_ccKey]) stats[_ccKey] = { label: _ccLabel, ms: 0 };
      stats[_ccKey].ms = (stats[_ccKey].ms || 0) + elapsed;
      stats[_ccKey].label = _ccLabel;
      localStorage.setItem('cc_usage_stats', JSON.stringify(stats));
    } catch (e) {}
    _ccStart = Date.now();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { _ccFlush(); _ccActive = false; }
    else { _ccStart = Date.now(); _ccActive = true; }
  });
  window.addEventListener('beforeunload', _ccFlush);
  window.addEventListener('pagehide', _ccFlush);
  setInterval(_ccFlush, 30000);

  // ── localStorage 配額預警 ──────────────────────────────────────
  var QUOTA_LIMIT_BYTES = 4194304; // 4MB（同源上限約 5MB，提前預警）

  function _ccTodayStr() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function _ccEstimateBytes() {
    var total = 0;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        var v = localStorage.getItem(k) || '';
        total += (k.length + v.length) * 2; // UTF-16 概估
      }
    } catch (e) {}
    return total;
  }

  function _ccShowQuotaBanner(bytes) {
    if (document.getElementById('cc-quota-banner')) return;
    var mb = (bytes / 1048576).toFixed(1);
    var bar = document.createElement('div');
    bar.id = 'cc-quota-banner';
    bar.setAttribute('style', [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'height:40px', 'line-height:40px', 'box-sizing:border-box',
      'padding:0 44px 0 16px', 'background:#f0dcb0', 'color:#28261f',
      'font-size:13px', 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'font-style:normal', 'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
      'box-shadow:0 1px 3px rgba(40,38,32,.16)'
    ].join(';'));
    bar.textContent = '⚠ 本站瀏覽器儲存空間已用 ' + mb + ' MB／約 5MB 上限，請先備份再清理';

    var viewBtn = document.createElement('span');
    viewBtn.textContent = '檢視與清理';
    viewBtn.setAttribute('style', [
      'display:inline-block', 'margin-left:12px', 'padding:0 10px', 'height:26px', 'line-height:26px',
      'background:#28261f', 'color:#f4f1ec', 'border-radius:13px', 'cursor:pointer',
      'font-size:12px', 'font-style:normal', 'vertical-align:middle'
    ].join(';'));
    viewBtn.addEventListener('click', function (e) { e.stopPropagation(); _ccOpenStoragePanel(); });
    bar.appendChild(viewBtn);

    var closeBtn = document.createElement('span');
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', '今日不再顯示');
    closeBtn.setAttribute('style', [
      'position:absolute', 'right:12px', 'top:0', 'height:40px', 'line-height:40px',
      'cursor:pointer', 'font-size:15px', 'font-style:normal', 'color:#55514a', 'padding:0 4px'
    ].join(';'));
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      try { localStorage.setItem('cc_quota_ack', _ccTodayStr()); } catch (err) {}
      bar.remove();
    });
    bar.appendChild(closeBtn);

    if (document.body) document.body.insertBefore(bar, document.body.firstChild);
  }

  function _ccCheckQuota() {
    var bytes = _ccEstimateBytes();
    try {
      localStorage.setItem('cc_quota_stat', JSON.stringify({ bytes: bytes, ts: Date.now() }));
    } catch (e) {}
    if (bytes > QUOTA_LIMIT_BYTES) {
      var ack = null;
      try { ack = localStorage.getItem('cc_quota_ack'); } catch (e) {}
      if (ack !== _ccTodayStr()) _ccShowQuotaBanner(bytes);
    }
  }

  // ── 儲存空間檢視與清理面板 ─────────────────────────────────────
  // 快取類（可安全清除，App 會自動重建）；其餘 key 只顯示大小，請在原 App 內清理
  var CC_CACHE_KEYS = {
    'aitracker_cache': 'AI Tracker 新聞快取（開頁自動重建）',
    'oasis_cache': 'Oasis 文章快取（重新整理自動補抓）',
    'oasis_status': 'Oasis 狀態快取',
    'astro_cc_brief': '每日星象簡報（明日自動重生成）',
    'cc_quota_stat': '空間量測統計（自動重算）',
    'notes_last_synced_hash': 'AI Tracker 筆記同步指紋（自動重算）',
    'cc_auto_hash': '全域備份變更指紋（自動重算，清除只會多跑一次備份）',
    'cc_auto_at': '全域備份節流時間戳（自動重算）'
  };
  var CC_CRED_RE = /^(gh_pat|gist_id|notes_gist_id|.*_token|.*_gist_id|groq_key|.*groq.*)$/;

  // key → 所屬 App 與中文用途（來源：audit_backup_status_260706 全 key 盤點）
  // 比對規則：字串以 * 結尾＝前綴比對，否則完全相等；由上而下取第一個命中
  var CC_KEY_INFO = [
    ['sas_dta', '🌙 SAS Hub', '睡眠戰力核心資料'],
    ['sas_weekly_recap', '🌙 SAS Hub', '週回顧'],
    ['sas_*', '🌙 SAS Hub', '睡眠/戰力衍生數值'],
    ['cc_energy_weights', '🌙 SAS Hub', '個人化能量權重'],
    ['lto_matrix', '🌳 External Me', '人生矩陣（含頭像圖片）'],
    ['astro_vedic_images', '⭐ Astro Bot', '上傳的命盤圖片'],
    ['astro_chat', '⭐ Astro Bot', '占星對話紀錄'],
    ['astro_forecast', '⭐ Astro Bot', '人生預測結果'],
    ['astro_myself', '⭐ Astro Bot', '我的星象'],
    ['astro_settings', '⭐ Astro Bot', '星盤設定與筆記'],
    ['astro_cc_brief', '⭐ Astro Bot', '每日簡報'],
    ['wellness_v5', '💛 Mental Dashboard', '主資料（紀錄/人際圈）'],
    ['mental_custom_emotions', '💛 Mental Dashboard', '自訂情緒標籤'],
    ['md_*', '💛 Mental Dashboard', '介面狀態'],
    ['review_*', '✅ Daily Optimizer', '每日覆盤'],
    ['tina_tasks*', '✅ Daily Optimizer', '自訂任務庫'],
    ['optimizer_*', '✅ Daily Optimizer', '自訂地點/心情'],
    ['note_*', '📰 AI Tracker', '每日筆記'],
    ['aitracker_cache', '📰 AI Tracker', '新聞快取'],
    ['gloss_*', '📰 AI Tracker', '詞彙表策展'],
    ['custom_cats', '📰 AI Tracker', '自訂分類'],
    ['notes_last_synced_hash', '📰 AI Tracker', '同步指紋'],
    ['notes_gist_id', '📰 AI Tracker', '筆記 Gist 位址'],
    ['wordvault_v1-kids', '🧒 WordVault Kids', '孩子單字庫'],
    ['wvk_*', '🧒 WordVault Kids', '孩子檔案/設定'],
    ['wordvault_v1', '📚 WordVault', '單字庫'],
    ['wordvault_*', '📚 WordVault', '設定'],
    ['wv_coll_*', '📚 WordVault', '介面摺疊狀態'],
    ['refueler_*', '⛽ Refueler', '加油紀錄（含收據照片欄位）'],
    ['oasis_saved', '🌿 Oasis', '收藏文章'],
    ['oasis_keywords', '🌿 Oasis', '關鍵字'],
    ['oasis_authors', '🌿 Oasis', '作者清單'],
    ['oasis_cache', '🌿 Oasis', '探索頁快取'],
    ['oasis_status', '🌿 Oasis', '狀態統計'],
    ['worship_*', '⛩️ Worship', '參拜紀錄'],
    ['es_saved_phrases', '🎯 English Sandbox', '精華句收藏'],
    ['es_idiom_lib', '🎯 English Sandbox', '片語字庫'],
    ['guard_*', '🐈 Guard', '提醒設定/靜默'],
    ['cc_links_v2', '🏠 CC 首頁', '捷徑連結'],
    ['cc_lab_projects', '🏠 CC 首頁', '實驗中專案'],
    ['cc_linkedin_v2', '🏠 CC 首頁', 'LinkedIn 卡片'],
    ['cc_wp_v1', '🏠 CC 首頁', '桌布'],
    ['cc_usage_stats', '🏠 CC 首頁', '使用頻率統計'],
    ['cc_big_manifest', '🏠 CC 首頁', '備份分塊索引（勿刪）'],
    ['cc_*', '🏠 CC 首頁', '同步/統計'],
    ['gh_pat', '🔑 憑證', 'GitHub PAT'],
    ['gist_id', '🔑 憑證', '備份 Gist 位址'],
    ['nexus_*', '🌳 External Me', 'NexusPortal 相關'],
    ['astro_active_tab', '⭐ Astro Bot', '介面分頁狀態'],
    ['astro_*', '⭐ Astro Bot', '其他資料'],
    ['do_*', '✅ Daily Optimizer', '同步設定/憑證'],
    ['gist_token', '💛 Mental Dashboard', '同步憑證'],
    ['groq_key', '🔑 憑證', 'Groq API key'],
    ['tina_groq', '🔑 憑證', 'Groq API key（舊名）'],
    ['oasis_groq_key', '🌿 Oasis', 'Groq API key'],
    ['oasis_last_*', '🌿 Oasis', '最近抓取時間'],
    ['oasis_*', '🌿 Oasis', '其他'],
    ['notion_token', '🔑 憑證', 'Notion token'],
    ['notion_li_db', '🏠 CC 首頁', 'Notion LinkedIn 設定'],
    ['wv_kids_coll_*', '🧒 WordVault Kids', '介面摺疊狀態'],
    ['wellness_v4', '💛 Mental Dashboard', '舊版資料（v5 已接手）'],
    ['wellness_*', '💛 Mental Dashboard', '資料'],
    ['es_*', '🎯 English Sandbox', '其他'],
    ['sleep_*', '🌙 SAS Hub', '睡眠資料'],
  ];

  // 舊版遺留 key：僅在「接手的新版 key 存在且有實質內容」時才開放清除
  var CC_LEGACY_KEYS = {
    'wellness_v4': { requires: 'wellness_v5' }
  };
  function _ccLegacyDeletable(k) {
    var cfg = CC_LEGACY_KEYS[k];
    if (!cfg) return false;
    try { return ((localStorage.getItem(cfg.requires) || '').length > 100); } catch (e) { return false; }
  }
  function _ccKeyInfo(k) {
    for (var i = 0; i < CC_KEY_INFO.length; i++) {
      var pat = CC_KEY_INFO[i][0];
      var hit = (pat.slice(-1) === '*') ? (k.indexOf(pat.slice(0, -1)) === 0) : (k === pat);
      if (hit) return { app: CC_KEY_INFO[i][1], desc: CC_KEY_INFO[i][2] };
    }
    return { app: '❓ 未歸類', desc: '' };
  }

  function _ccFmtSize(chars) {
    var b = chars * 2;
    return b >= 1048576 ? (b / 1048576).toFixed(2) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  }

  function _ccOpenStoragePanel() {
    var old = document.getElementById('cc-storage-panel');
    if (old) old.remove();
    var wrap = document.createElement('div');
    wrap.id = 'cc-storage-panel';
    wrap.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;background:rgba(40,38,32,.45);display:flex;align-items:center;justify-content:center;padding:18px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-style:normal;');
    var panel = document.createElement('div');
    panel.setAttribute('style', 'background:#f4f1ec;color:#28261f;border-radius:14px;max-width:560px;width:100%;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(40,38,32,.3);overflow:hidden;');

    var head = document.createElement('div');
    head.setAttribute('style', 'padding:16px 18px 10px;font-size:14px;font-weight:700;');
    var lastSync = '';
    try { lastSync = localStorage.getItem('cc_last_sync') || ''; } catch (e) {}
    head.textContent = '儲存空間（共 ' + (_ccEstimateBytes() / 1048576).toFixed(1) + ' MB）' + (lastSync ? '　上次備份 ' + lastSync : '　尚未備份');
    panel.appendChild(head);

    var note = document.createElement('div');
    note.setAttribute('style', 'padding:0 18px 10px;font-size:11.5px;color:#55514a;line-height:1.6;');
    note.textContent = '標「快取」者可安全勾選清除（App 會自動重建）；標「舊版」者為新版已接手的遺留資料，確認 App 正常後可清除。其餘為資料或設定，請在對應 App 內整理；清除前請確認上次備份時間。';
    panel.appendChild(note);

    var list = document.createElement('div');
    list.setAttribute('style', 'overflow-y:auto;padding:0 12px;flex:1;');
    var rows = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        // __idb 索引 key 只是一個 '1' 標記，不單獨列一行；下方會用它找出對應的 IndexedDB 合併行
        if (k.slice(-6) === '__idb') continue;
        rows.push({ k: k, len: (localStorage.getItem(k) || '').length });
      }
    } catch (e) {}
    rows.sort(function (a, b) { return b.len - a.len; });
    var checks = [];
    function _ccRenderRow(r) {
      var isCache = Object.prototype.hasOwnProperty.call(CC_CACHE_KEYS, r.k);
      var isLegacy = _ccLegacyDeletable(r.k);
      var canDel = (isCache || isLegacy) && !r.isIdb;
      var isCred = CC_CRED_RE.test(r.k);
      var row = document.createElement('label');
      row.setAttribute('style', 'display:flex;align-items:center;gap:8px;padding:7px 6px;border-bottom:1px solid #e4e0d6;font-size:12px;cursor:' + (canDel ? 'pointer' : 'default') + ';');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.disabled = !canDel;
      cb.dataset.key = r.k;
      cb.setAttribute('style', 'flex:none;' + (canDel ? '' : 'visibility:hidden;'));
      if (canDel) checks.push(cb);
      row.appendChild(cb);
      var info = _ccKeyInfo(r.k);
      var name = document.createElement('span');
      name.setAttribute('style', 'flex:1;min-width:0;overflow:hidden;display:flex;flex-direction:column;gap:1px;');
      var line1 = document.createElement('span');
      line1.setAttribute('style', 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;');
      line1.textContent = info.app + (info.desc ? '　' + info.desc : '');
      name.appendChild(line1);
      var line2 = document.createElement('span');
      line2.setAttribute('style', 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:#9e9890;');
      line2.textContent = r.k + (isCache ? '　— ' + CC_CACHE_KEYS[r.k] : r.isIdb ? '　— 已搬 IndexedDB，不計入 5MB 上限' : '');
      name.appendChild(line2);
      row.appendChild(name);
      var tag = document.createElement('span');
      tag.setAttribute('style', 'flex:none;font-size:10px;padding:1px 7px;border-radius:8px;background:' + (r.isIdb ? '#d8e2ec' : isCache ? '#dce8d8' : isLegacy ? '#f0dcb0' : isCred ? '#e8e0d0' : '#e4e0d6') + ';color:#55514a;');
      tag.textContent = r.isIdb ? 'IndexedDB' : isCache ? '快取' : isLegacy ? '舊版' : isCred ? '設定' : '資料';
      row.appendChild(tag);
      var sz = document.createElement('span');
      sz.setAttribute('style', 'flex:none;width:72px;text-align:right;font-variant-numeric:tabular-nums;color:#55514a;');
      sz.textContent = r.sizeLabel || _ccFmtSize(r.len + r.k.length);
      row.appendChild(sz);
      return row;
    }
    rows.forEach(function (r) { list.appendChild(_ccRenderRow(r)); });
    panel.appendChild(list);

    // 已搬 IndexedDB 的圖片類 key：另外非同步查詢實際大小，補一行（不計入上方 5MB 總量，因為
    // _ccEstimateBytes() 只掃 localStorage；這裡單純是給使用者看清楚資料還在，沒有不見）。
    (function () {
      var idbKeys = window.CC_IDB_IMAGE_KEYS || [];
      var migrated = idbKeys.filter(function (key) {
        try { return localStorage.getItem(key + '__idb') === '1'; } catch (e) { return false; }
      });
      if (!migrated.length || !window.ccStore) return;
      var totalIdbBytes = 0;
      var pending = migrated.length;
      migrated.forEach(function (key) {
        window.ccStore.get(key).then(function (v) {
          var len = (v || '').length;
          totalIdbBytes += (len + key.length) * 2;
          list.appendChild(_ccRenderRow({ k: key, len: len, isIdb: true, sizeLabel: _ccFmtSize(len + key.length) }));
        }).catch(function () {
          list.appendChild(_ccRenderRow({ k: key, len: 0, isIdb: true, sizeLabel: '讀取失敗' }));
        }).finally(function () {
          pending--;
          if (pending === 0 && totalIdbBytes > 0) {
            var extra = document.createElement('div');
            extra.setAttribute('style', 'padding:6px 18px 0;font-size:10.5px;color:#7a9ab0;');
            extra.textContent = '另有 ' + (totalIdbBytes / 1048576).toFixed(2) + ' MB 圖片資料存在 IndexedDB，不受此頁 5MB 上限影響。';
            panel.insertBefore(extra, list);
          }
        });
      });
    })();

    var foot = document.createElement('div');
    foot.setAttribute('style', 'display:flex;gap:10px;justify-content:flex-end;padding:12px 18px;border-top:1px solid #e4e0d6;');
    function mkBtn(label, primary) {
      var b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('style', 'border:0;border-radius:10px;padding:7px 16px;font-size:12.5px;cursor:pointer;font-style:normal;' +
        (primary ? 'background:#28261f;color:#f4f1ec;' : 'background:#e4e0d6;color:#28261f;'));
      return b;
    }
    var selAll = mkBtn('全選快取', false);
    selAll.addEventListener('click', function () { checks.forEach(function (c) { c.checked = true; }); });
    var doClean = mkBtn('清除勾選', true);
    doClean.addEventListener('click', function () {
      var picked = checks.filter(function (c) { return c.checked; }).map(function (c) { return c.dataset.key; });
      if (!picked.length) return;
      if (!window.confirm('確定清除以下快取？App 會在需要時自動重建：\n\n' + picked.join('\n'))) return;
      picked.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
      wrap.remove();
      var bar = document.getElementById('cc-quota-banner');
      if (bar) bar.remove();
      _ccCheckQuota();
      _ccOpenStoragePanel();
    });
    var closeB = mkBtn('關閉', false);
    closeB.addEventListener('click', function () { wrap.remove(); });
    foot.appendChild(selAll); foot.appendChild(doClean); foot.appendChild(closeB);
    panel.appendChild(foot);

    wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
    wrap.appendChild(panel);
    document.body.appendChild(wrap);
  }

  setTimeout(_ccCheckQuota, 3000);

  // 供頁面按鈕直接開啟儲存空間面板（CC 首頁 #storage-btn 等）
  window.ccOpenStoragePanel = _ccOpenStoragePanel;
})();
