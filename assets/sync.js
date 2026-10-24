/* 本机缓存 + 待发队列 + 和服务器同步。window.CnmSync。
 *
 * 数据先写本机（离线也能用），同时记进待发队列；登录后自动推到服务器、拉回别的设备的修改。
 * 每一项记着服务器版本 rev。改一项时把当时看到的 rev 作为 baseRev 一起发上去，
 * 服务器发现别的设备已经改过，就拒绝这次修改并把它那份发回来，本机以服务器为准（见 server/app/sync.py）。
 *
 * 存储：cnmSync.v1 = { cursor, items: { kind: { id: { rev, data } } }, outbox: { key: change } }
 *       cnmAuth.v1 = { token, username }
 * 页面监听 window 的 'cnm:sync' 事件：detail = { status, pending, changed, conflicts }。 */
(function () {
  'use strict';
  var STORE_KEY = 'cnmSync.v1';
  var AUTH_KEY = 'cnmAuth.v1';
  var SEP = '\n';
  var RETRY_MS = [5000, 15000, 60000, 300000];

  function read(k, fallback) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function write(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
  }
  function store() {
    var s = read(STORE_KEY, null);
    if (!s || typeof s !== 'object' || !s.items || !s.outbox) s = { cursor: 0, items: {}, outbox: {}, seq: 0 };
    return s;
  }
  function bucket(s, kind) { return s.items[kind] || (s.items[kind] = {}); }
  function okey(kind, id) { return kind + SEP + id; }

  /* ---------- 读 ---------- */

  function all(kind) {
    var b = store().items[kind] || {};
    return Object.keys(b).map(function (id) { return { id: id, rev: b[id].rev, data: b[id].data }; });
  }
  function get(kind, id) {
    var it = (store().items[kind] || {})[id];
    return it ? { id: id, rev: it.rev, data: it.data } : null;
  }

  /* ---------- 写：先改本机，再记进待发队列 ---------- */

  function queue(s, kind, id, deleted, data) {
    var k = okey(kind, id);
    var cur = bucket(s, kind)[id];
    var prev = s.outbox[k];
    // 同一项连改几次，只发最后一次；baseRev 用第一次改之前看到的服务器版本
    var baseRev = prev ? prev.baseRev : (cur ? cur.rev : 0);
    s.seq = (s.seq || 0) + 1;
    if (deleted && baseRev === 0) delete s.outbox[k]; // 还没到过服务器，直接扔掉
    else s.outbox[k] = { kind: kind, id: id, baseRev: baseRev, deleted: !!deleted, data: deleted ? null : data, seq: s.seq };
  }
  function put(kind, id, data) {
    var s = store();
    var cur = bucket(s, kind)[id];
    queue(s, kind, id, false, data);
    bucket(s, kind)[id] = { rev: cur ? cur.rev : 0, data: data };
    if (!write(STORE_KEY, s)) return false;
    changed();
    return true;
  }
  function remove(kind, id) {
    var s = store();
    if (!bucket(s, kind)[id] && !s.outbox[okey(kind, id)]) return true;
    queue(s, kind, id, true, null);
    delete bucket(s, kind)[id];
    if (!write(STORE_KEY, s)) return false;
    changed();
    return true;
  }
  function pendingCount() { return Object.keys(store().outbox).length; }

  /* ---------- 账号 ---------- */

  function auth() { return read(AUTH_KEY, null); }
  function loggedIn() { var a = auth(); return !!(a && a.token); }

  function api(path, opts) {
    opts = opts || {};
    var a = auth();
    var headers = { 'Content-Type': 'application/json' };
    if (a && a.token) headers.Authorization = 'Bearer ' + a.token;
    return fetch((window.CNM_API_BASE || '') + path, {
      method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store'
    }).then(function (res) {
      return res.text().then(function (t) {
        var body = null;
        try { body = t ? JSON.parse(t) : null; } catch (e) { /* 非 JSON */ }
        if (!res.ok) {
          var err = new Error((body && typeof body.detail === 'string' && body.detail) || ('服务器返回 ' + res.status));
          err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  }

  function login(username, password) {
    var device = (navigator.userAgent.match(/\(([^)]+)\)/) || [])[1] || '';
    return api('/api/login', { method: 'POST', body: { username: username, password: password, device: device } }).then(function (r) {
      write(AUTH_KEY, { token: r.token, username: r.username });
      return syncNow().then(function () { return r; });
    });
  }
  /* 退出登录：清掉本机的档案和记录，免得下一个登录的人看到。还有没同步的修改时调用方先问用户。 */
  function logout() {
    var done = function () {
      localStorage.removeItem(AUTH_KEY);
      localStorage.removeItem(STORE_KEY);
      state.status = 'local';
      changed();
    };
    if (!loggedIn()) { done(); return Promise.resolve(); }
    return api('/api/logout', { method: 'POST' }).catch(function () { /* 断网也照样退出本机 */ }).then(done);
  }

  /* ---------- 同步 ---------- */

  var state = { status: loggedIn() ? 'idle' : 'local', lastSyncAt: null, error: '', inflight: null, timer: null, retry: 0 };

  function emit(extra) {
    var detail = Object.assign({ status: state.status, pending: pendingCount(), lastSyncAt: state.lastSyncAt, error: state.error,
      changed: false, conflicts: [] }, extra || {});
    window.dispatchEvent(new CustomEvent('cnm:sync', { detail: detail }));
  }
  function changed() { emit({ changed: true }); schedule(400); }

  function schedule(ms) {
    if (!loggedIn()) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(function () { syncNow(); }, ms);
  }

  function apply(s, rows, skipPending) {
    rows.forEach(function (row) {
      if (skipPending && s.outbox[okey(row.kind, row.id)]) return; // 本机还有没发出去的修改，先留着本机的
      if (row.deleted) delete bucket(s, row.kind)[row.id];
      else bucket(s, row.kind)[row.id] = { rev: row.rev, data: row.data };
    });
  }

  function syncNow() {
    if (!loggedIn()) { state.status = 'local'; emit(); return Promise.resolve(); }
    if (state.inflight) return state.inflight;
    var s0 = store();
    var sent = Object.keys(s0.outbox).map(function (k) { return s0.outbox[k]; });
    state.status = 'syncing';
    emit();
    state.inflight = api('/api/sync', {
      method: 'POST',
      body: { since: s0.cursor || 0, changes: sent.map(function (c) { return { kind: c.kind, id: c.id, baseRev: c.baseRev, deleted: c.deleted, data: c.data }; }) }
    }).then(function (res) {
      var s = store(); // 请求期间本机可能又改了，重新读
      var byKey = {};
      res.changes.forEach(function (r) { byKey[okey(r.kind, r.id)] = r; });
      var conflictKeys = {};
      res.conflicts.forEach(function (r) { conflictKeys[okey(r.kind, r.id)] = true; });
      sent.forEach(function (c) {
        var k = okey(c.kind, c.id);
        var now = s.outbox[k];
        if (!now) return;
        if (now.seq === c.seq || conflictKeys[k]) { delete s.outbox[k]; return; }
        // 发出去之后本机又改了：保留新的修改，baseRev 换成刚被接受的那个版本
        if (byKey[k]) now.baseRev = byKey[k].rev;
      });
      if (res.reset) {
        var keep = {};
        Object.keys(s.outbox).forEach(function (k) {
          var o = s.outbox[k];
          if (!o.deleted) (keep[o.kind] || (keep[o.kind] = {}))[o.id] = s.items[o.kind] && s.items[o.kind][o.id];
        });
        s.items = keep;
      }
      apply(s, res.changes, true);
      apply(s, res.conflicts, false);
      s.cursor = res.rev;
      write(STORE_KEY, s);
      state.lastSyncAt = new Date().toISOString();
      state.error = '';
      state.retry = 0;
      state.status = Object.keys(s.outbox).length ? 'pending' : 'synced';
      emit({ changed: res.changes.length > 0 || res.conflicts.length > 0, conflicts: res.conflicts });
      if (Object.keys(s.outbox).length) schedule(200);
    }, function (err) {
      if (err.status === 401) {
        // 凭证失效（改了密码或被退出）：本机数据留着，重新登录后接着同步
        localStorage.removeItem(AUTH_KEY);
        state.status = 'local';
        state.error = '登录已失效，请重新登录。';
      } else {
        state.status = 'offline';
        state.error = err.status ? err.message : '连不上服务器，联网后会自动同步。';
        schedule(RETRY_MS[Math.min(state.retry++, RETRY_MS.length - 1)]);
      }
      emit();
    }).then(function () { state.inflight = null; });
    return state.inflight;
  }

  window.addEventListener('online', function () { schedule(0); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') schedule(0); });
  // 别的标签页改了数据
  window.addEventListener('storage', function (e) { if (e.key === STORE_KEY || e.key === AUTH_KEY) emit({ changed: true }); });

  window.CnmSync = {
    all: all, get: get, put: put, remove: remove,
    loggedIn: loggedIn, username: function () { var a = auth(); return a ? a.username : ''; },
    login: login, logout: logout, syncNow: syncNow, pendingCount: pendingCount,
    status: function () { return { status: state.status, pending: pendingCount(), lastSyncAt: state.lastSyncAt, error: state.error }; }
  };
  schedule(0);
})();
