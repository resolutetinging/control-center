/**
 * cc_autosync.js — Control Center 全量自動同步
 * 合蓋 / 切換 App 時觸發，把所有 localStorage 資料備份到 Gist (cc_sync.json)
 * 使用方式：各頁面 </body> 前加 <script src="cc_autosync.js"></script>
 */
(function () {
  'use strict';

  const SKIP_KEYS = [
    'gh_pat','gist_id','tina_groq','groq_key','groq_api_key',
    'wordvault_groq_key','notion_token','do_gist_token','do_gist_id',
    'wordvault_gist_token','wordvault_gist_id','gist_token'
  ];
  const PAT_RE = /ghp_[A-Za-z0-9]{10,}|ghs_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|gsk_[A-Za-z0-9]{10,}/;

  function buildSnapshot() {
    const snap = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (SKIP_KEYS.includes(k) || k.startsWith('gsk_')) continue;
      const v = localStorage.getItem(k) || '';
      if (PAT_RE.test(v)) continue;
      snap[k] = v;
    }
    return snap;
  }

  function autoSync() {
    const pat = localStorage.getItem('gh_pat') || '';
    const gid = (localStorage.getItem('gist_id') || '').trim();
    if (!pat || !gid) return;

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

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) autoSync();
  });
})();
