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
    bar.textContent = '⚠ 本站瀏覽器儲存空間已用 ' + mb + ' MB／約 5MB 上限，請至 Control Center 備份並清理';

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

  setTimeout(_ccCheckQuota, 3000);
})();
