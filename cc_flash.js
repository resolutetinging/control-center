// cc_flash.js — 卡片內容變動提示（11-26 新增）
// 每張卡記下上次看到時的文字指紋；這次打開若內容不同（或是新出現的卡），卡片捲進畫面時外框低調閃 2 次，閃過才記為已讀。
// 第一次在這台裝置開該頁只建立紀錄、不閃。紀錄只存本機（localStorage cc_flash_seen_v1），不進 Gist 同步。
// 用法：<script src=".../control-center/cc_flash.js" data-flash-sel=".card" data-flash-page="頁面代號"></script>
//   data-flash-sel：卡片選擇器（巢狀命中時只取最外層）；data-flash-page：省略時用檔名
//   卡內會自己跳動的元素（倒數、時鐘）加 data-flash-ignore；input／textarea／select／canvas 一律不計
//   卡片識別：data-flash-key → id → 卡內第一個標題文字 → 順序
(function(){
  if (window.ccFlash) return;
  var KEY = 'cc_flash_seen_v1', CAP = 300;
  var me = document.currentScript;
  var SEL = (me && me.getAttribute('data-flash-sel')) || '.card';
  var PAGE = (me && me.getAttribute('data-flash-page')) || (location.pathname.split('/').pop() || 'index');
  var IGN = 'input,textarea,select,script,style,canvas,svg,[data-flash-ignore]';

  function load(){
    try { var o = JSON.parse(localStorage.getItem(KEY) || '{}'); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
    catch (e) { return {}; }
  }
  function save(){
    try { var all = load(); all[PAGE] = pg; localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) {}
  }
  function hash(s){ var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function textOf(el){
    var c = el.cloneNode(true);
    var ig = c.querySelectorAll(IGN);
    for (var i = 0; i < ig.length; i++) ig[i].parentNode && ig[i].parentNode.removeChild(ig[i]);
    return (c.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function keyOf(el, i){
    var k = el.getAttribute('data-flash-key') || el.id;
    if (k) return '#' + k;
    var h = el.querySelector('h1,h2,h3,h4,.card-title');
    var t = h ? textOf(h).slice(0, 60) : '';
    return t ? 't:' + t : 'i:' + i;
  }
  function setSeen(k, h){
    if (Object.prototype.hasOwnProperty.call(pg, k)) delete pg[k];   // 移到最後＝最新
    pg[k] = h;
    var ks = Object.keys(pg);
    for (var i = 0; i < ks.length - CAP; i++) delete pg[ks[i]];
  }

  var stored = load()[PAGE];
  var first = !(stored && typeof stored === 'object' && !Array.isArray(stored));
  var pg = first ? {} : stored;

  var css = document.createElement('style');
  css.textContent = '@keyframes ccFlashPulse{0%,100%{box-shadow:0 0 0 0 rgba(96,122,160,0)}50%{box-shadow:0 0 0 2px rgba(96,122,160,.55)}}'
    + '.cc-flash{animation:ccFlashPulse 1.2s ease-in-out 2}'
    + '@media (prefers-reduced-motion:reduce){.cc-flash{animation:none;box-shadow:0 0 0 2px rgba(96,122,160,.45)}}';
  (document.head || document.documentElement).appendChild(css);

  var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function(ents){
    ents.forEach(function(en){
      if (!en.isIntersecting) return;
      var el = en.target; io.unobserve(el);
      if (!el._ccfPend) return;
      flash(el); setSeen(el._ccfPend.k, el._ccfPend.h); el._ccfPend = null; save();
    });
  }, {threshold: 0.3}) : null;

  function flash(el){
    el.classList.remove('cc-flash'); void el.offsetWidth; el.classList.add('cc-flash');
    setTimeout(function(){ el.classList.remove('cc-flash'); }, 2600);
  }

  function scan(){
    var els = document.querySelectorAll(SEL), dirty = false;
    for (var i = 0; i < els.length; i++){
      var el = els[i];
      if (el.parentElement && el.parentElement.closest(SEL)) continue;
      var k = keyOf(el, i), h = hash(textOf(el));
      if (el._ccfH === h && el._ccfK === k) continue;
      el._ccfH = h; el._ccfK = k;
      if (first || pg[k] === h){
        if (pg[k] !== h){ setSeen(k, h); dirty = true; }
        el._ccfPend = null;
        continue;
      }
      el._ccfPend = {k: k, h: h};
      if (io) io.observe(el); else { flash(el); setSeen(k, h); el._ccfPend = null; dirty = true; }
    }
    if (dirty) save();
  }

  var t = null;
  // first 整個工作階段維持：第一次開這頁時，非同步載入或之後才點開分頁的卡也只建紀錄、不閃
  function later(){ clearTimeout(t); t = setTimeout(scan, 500); }
  function start(){
    later();
    try { new MutationObserver(later).observe(document.body, {childList: true, subtree: true, characterData: true}); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  window.ccFlash = { scan: scan, page: PAGE };
})();
