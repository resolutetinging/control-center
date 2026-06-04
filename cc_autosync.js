/**
 * cc_autosync.js — Control Center 全量自動同步
 * 合蓋 / 切換 App / 離頁時觸發，把所有 localStorage 資料備份到 Gist (cc_sync.json)
 * 使用方式：各頁面 </body> 前加 <script src="cc_autosync.js"></script>
 *
 * 安全機制：正向白名單（只有明確列出的生活數據 key 才會上傳，憑證類 key 不列入白名單，物理隔離）
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
    // Mental Dashboard（唯讀 key，供 SAS Hub 讀取）
    'wellness_v5', 'md_card_st', 'md_last_view',
    // Astro Bot
    'astro_settings', 'astro_vedic_images', 'astro_myself', 'astro_forecast',
    'astro_chat', 'astro_cc_brief',
    // English Sandbox
    'es_idiom_lib', 'es_saved_phrases',
  ]);

  // 動態 key 前綴白名單（每日覆盤 / AI Tracker 筆記 / Guard 靜默 / 其他日期型 key）
  const SAFE_PREFIXES = [
    'review_',      // Daily Optimizer 每日覆盤 review_YYYY-MM-DD
    'note_',        // AI Tracker 今日筆記 note_YYYY-MM-DD
    'guard_snooze_', // Guard 今日靜默 guard_snooze_YYYY-MM-DD
  ];

  function isSafeKey(k) {
    if (SAFE_STATIC_KEYS.has(k)) return true;
    for (const prefix of SAFE_PREFIXES) {
      if (k.startsWith(prefix)) return true;
    }
    return false;
  }

  // 保險層：即使某個 key 意外混入白名單，值中若含憑證格式字串也阻擋
  const PAT_RE = /ghp_[A-Za-z0-9]{10,}|ghs_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|gsk_[A-Za-z0-9]{10,}/;

  let _fired = false;

  function buildSnapshot() {
    const snap = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!isSafeKey(k)) continue;           // 不在白名單 → 跳過
      const v = localStorage.getItem(k) || '';
      if (PAT_RE.test(v)) continue;           // 值含憑證格式 → 阻擋（保險層）
      snap[k] = v;
    }
    return snap;
  }

  function autoSync() {
    const pat = localStorage.getItem('gh_pat') || '';
    const gid = (localStorage.getItem('gist_id') || '').trim();
    if (!pat || !gid) return;

    // 在 buildSnapshot 前寫時間戳，讓 Gist 帶最新時間，pill 下次載入即可更新
    const nowStr = new Date().toLocaleString('zh-TW', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    localStorage.setItem('cc_last_sync', nowStr);

    const snap = buildSnapshot();
    if (!Object.keys(snap).length) return;

    // keepalive: true 確保合蓋後請求仍會送達
    fetch('https://api.github.com/gists/' + gid, {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + pat,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json'
      },
      body: JSON.stringify({ files: { 'cc_sync.json': { content: JSON.stringify(snap) } } }),
      keepalive: true
    }).catch(() => {});
  }

  function trigger() {
    if (_fired) return;
    _fired = true;
    autoSync();
    // 5s 後重置，允許同一頁面下次再觸發
    setTimeout(() => { _fired = false; }, 5000);
  }

  // visibilitychange：合蓋、切換 App、螢幕鎖定
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) trigger();
  });

  // pagehide：導航離頁、關閉分頁（visibilitychange 的備援）
  window.addEventListener('pagehide', trigger);
})();
