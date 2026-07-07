/**
 * cc_store.js — CC 家族共用 IndexedDB wrapper（2026-07-07 新增）
 *
 * 唯一事實來源：圖片類資料（桌布、命盤圖片等 base64 大字串）一律走此檔，
 * 不再直接塞進 localStorage（iPhone/iPad Safari 同源上限約 5MB，圖片極易撐爆）。
 *
 * 用法：
 *   <script src="cc_store.js"></script>   ← 放在所有其他 inline script 之前
 *   await ccStore.put(key, stringValue)
 *   await ccStore.get(key)                → 找不到回傳 undefined
 *   await ccStore.del(key)
 *   await ccStore.keys()
 *   ccStore.peek(key)                     → 同步讀「本次 session 已載入/寫入過」的鏡像快取，
 *                                            沒有就回傳 undefined（不會自動觸發 IndexedDB 讀取）
 *   await ccStore.migrate(key)             → 一次性遷移：localStorage 讀出→put→get 回讀比對一致
 *                                            才 removeItem；任何一步失敗就保留原狀（console.warn）。
 *                                            已遷移過（<key>__idb==='1'）或原本沒有資料則直接跳過。
 *
 * 瀏覽器不支援 IndexedDB 時，get/put/del 自動 fallback 回 localStorage（保底不壞）。
 *
 * CC_IDB_IMAGE_KEYS：目前已遷移到 IndexedDB 的圖片類 key 清單，
 * 供 cc_autosync.js（備份/還原）與 cc_track.js（清理面板顯示）共用，勿各自維護一份。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'cc_store';
  var STORE_NAME = 'kv';
  var DB_VERSION = 1;

  var _supported = (typeof indexedDB !== 'undefined');
  var _dbPromise = null;
  var _cache = Object.create(null); // 同步鏡像快取，peek() 用

  function openDB() {
    if (!_supported) return Promise.reject(new Error('indexedDB not supported'));
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('indexedDB open failed')); };
    });
    return _dbPromise;
  }

  function withStore(mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx, store, req;
        try {
          tx = db.transaction(STORE_NAME, mode);
          store = tx.objectStore(STORE_NAME);
          req = fn(store);
        } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(req ? req.result : undefined); };
        tx.onerror = function () { reject(tx.error || new Error('indexedDB tx failed')); };
        tx.onabort = function () { reject(tx.error || new Error('indexedDB tx aborted')); };
      });
    });
  }

  function get(key) {
    return withStore('readonly', function (store) { return store.get(key); })
      .then(function (v) { _cache[key] = v; return v; })
      .catch(function (e) {
        console.warn('[cc_store] get 失敗，fallback 回 localStorage：', key, e);
        try {
          var raw = localStorage.getItem(key);
          var v = (raw === null) ? undefined : raw;
          _cache[key] = v;
          return v;
        } catch (e2) { return undefined; }
      });
  }

  function put(key, value) {
    _cache[key] = value; // 先同步更新鏡像快取，供 peek() 即時讀取
    return withStore('readwrite', function (store) { return store.put(value, key); })
      .catch(function (e) {
        console.warn('[cc_store] put 失敗，fallback 回 localStorage：', key, e);
        try { localStorage.setItem(key, value); } catch (e2) { console.warn('[cc_store] localStorage fallback 也失敗：', key, e2); }
      });
  }

  function del(key) {
    delete _cache[key];
    return withStore('readwrite', function (store) { return store.delete(key); })
      .catch(function (e) {
        console.warn('[cc_store] del 失敗，fallback 回 localStorage：', key, e);
        try { localStorage.removeItem(key); } catch (e2) {}
      });
  }

  function keys() {
    return withStore('readonly', function (store) {
      return store.getAllKeys();
    }).catch(function (e) {
      console.warn('[cc_store] keys() 失敗：', e);
      return [];
    });
  }

  function peek(key) { return _cache[key]; }

  // 一次性遷移：localStorage → IndexedDB，get 回讀比對一致才刪 localStorage 原值。
  // 任何一步失敗都保留 localStorage 原狀，下次載入再試一次（不會遺失資料）。
  function migrate(key) {
    var markerKey = key + '__idb';
    return Promise.resolve().then(function () {
      var already;
      try { already = localStorage.getItem(markerKey) === '1'; } catch (e) { already = false; }
      if (already) return; // 已遷移過，跳過
      var raw;
      try { raw = localStorage.getItem(key); } catch (e) { console.warn('[cc_store] migrate 讀取 localStorage 失敗：', key, e); return; }
      if (raw === null || raw === undefined) return; // 本來就沒資料，無需遷移
      return put(key, raw).then(function () {
        return get(key);
      }).then(function (back) {
        if (back === raw) {
          try {
            localStorage.removeItem(key);
            localStorage.setItem(markerKey, '1');
          } catch (e) { console.warn('[cc_store] migrate 清除 localStorage 原值失敗（IndexedDB 已有一份，下次再試）：', key, e); }
        } else {
          console.warn('[cc_store] migrate 回讀比對不一致，保留 localStorage 原值：', key);
        }
      });
    }).catch(function (e) {
      console.warn('[cc_store] migrate 失敗，保留 localStorage 原狀：', key, e);
    });
  }

  // 全 CC 家族目前已遷移到 IndexedDB 的圖片類 key（cc_autosync.js / cc_track.js 共用）
  var CC_IDB_IMAGE_KEYS = ['cc_wp_v1', 'astro_vedic_images'];

  global.ccStore = { get: get, put: put, del: del, keys: keys, peek: peek, migrate: migrate, DB_NAME: DB_NAME, STORE_NAME: STORE_NAME };
  global.CC_IDB_IMAGE_KEYS = CC_IDB_IMAGE_KEYS;
})(window);
