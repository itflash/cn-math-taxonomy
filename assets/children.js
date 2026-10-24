/* 孩子档案：多个孩子、当前孩子、每个孩子的诊断记录。诊断页和档案页共用。window.CnmChildren。
 * 档案和记录存在 CnmSync（assets/sync.js）里：先写本机，登录后和服务器同步，同一个家庭账号的设备都能看到。
 * 「当前孩子」是每台设备自己的选择，只存本机，不同步。 */
(function () {
  'use strict';
  var S = window.CnmSync;
  var CURRENT_KEY = 'cnmChildren.current.v1';
  var MAX_CHILDREN = 8;
  var GRADES = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '七年级', '八年级', '九年级', '高一', '高二', '高三'];
  var TEXTBOOKS = ['人教版', '北师大版', '苏教版', '沪教版', '外研版', '译林版', '其他'];

  function newId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function bySavedDesc(a, b) { return String(b.savedAt).localeCompare(String(a.savedAt)); }

  function list() {
    return S.all('child').map(function (it) { return Object.assign({}, it.data, { id: it.id }); })
      .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
  }
  function get(id) { return list().filter(function (c) { return c.id === id; })[0] || null; }
  /* 没选过时默认第一个孩子；选了「不保存到档案」存成空字符串，表示明确不要。 */
  function current() {
    var id = localStorage.getItem(CURRENT_KEY);
    if (id === '') return null;
    var kids = list();
    return kids.filter(function (c) { return c.id === id; })[0] || kids[0] || null;
  }
  function setCurrent(id) {
    if (id && !get(id)) return false;
    try {
      localStorage.setItem(CURRENT_KEY, id || '');
      return true;
    } catch (e) { return false; }
  }

  function clean(f) {
    var name = String(f && f.name || '').replace(/\s+/g, ' ').trim();
    var grade = GRADES.indexOf(f && f.grade) >= 0 ? f.grade : '';
    var textbook = TEXTBOOKS.indexOf(f && f.textbook) >= 0 ? f.textbook : TEXTBOOKS[0];
    return { name: name, grade: grade, textbook: textbook };
  }
  function check(kids, f, selfId) {
    if (!f.name) return '请填写孩子的昵称。';
    if (f.name.length > 12) return '昵称最多 12 个字。';
    if (!f.grade) return '请选择年级。';
    if (kids.some(function (c) { return c.id !== selfId && c.name === f.name; })) return '已经有叫「' + f.name + '」的孩子了，换个昵称区分。';
    return '';
  }
  var SAVE_FAILED = '浏览器不允许保存数据（可能是隐私模式或空间已满），档案无法保存。';

  /* 返回 { ok, error, child } */
  function add(form) {
    var kids = list();
    var f = clean(form);
    if (kids.length >= MAX_CHILDREN) return { ok: false, error: '最多可以建 ' + MAX_CHILDREN + ' 个孩子。' };
    var err = check(kids, f, null);
    if (err) return { ok: false, error: err };
    var id = newId();
    var data = { name: f.name, grade: f.grade, textbook: f.textbook, createdAt: new Date().toISOString() };
    if (!S.put('child', id, data)) return { ok: false, error: SAVE_FAILED };
    if (!kids.length || !localStorage.getItem(CURRENT_KEY)) setCurrent(id);
    return { ok: true, child: Object.assign({ id: id }, data) };
  }
  function update(id, form) {
    var it = S.get('child', id);
    if (!it) return { ok: false, error: '找不到这个孩子。' };
    var f = clean(form);
    var err = check(list(), f, id);
    if (err) return { ok: false, error: err };
    var data = Object.assign({}, it.data, f);
    if (!S.put('child', id, data)) return { ok: false, error: SAVE_FAILED };
    return { ok: true, child: Object.assign({ id: id }, data) };
  }
  function remove(id) {
    recordsOf(id).forEach(function (r) { S.remove('record', r.key); });
    S.remove('child', id);
    if (localStorage.getItem(CURRENT_KEY) === id) localStorage.removeItem(CURRENT_KEY);
  }

  /* 记录在服务器上按 key（subject|seed|目标）存，data.childId 指向所属孩子。 */
  function recordsOf(childId) {
    return S.all('record').map(function (it) { return it.data; })
      .filter(function (r) { return r && r.childId === childId; })
      .sort(bySavedDesc);
  }
  function sameContent(a, b) {
    var strip = function (r) { var c = Object.assign({}, r); delete c.savedAt; delete c.updatedAt; return JSON.stringify(c); };
    return strip(a) === strip(b);
  }
  /* 按 rec.key 覆盖：同一次诊断反复打开结果页、更正答案，只会更新这一条。内容没变就不写，免得每次打开结果页都同步一次。 */
  function saveRecord(childId, rec) {
    if (!childId || !rec || !rec.key) return false;
    var old = S.get('record', rec.key);
    var now = new Date().toISOString();
    var data = Object.assign({}, rec, { childId: childId, savedAt: old ? old.data.savedAt : now, updatedAt: now });
    if (old && sameContent(old.data, data)) return true;
    return S.put('record', rec.key, data);
  }
  function hasRecord(childId, key) {
    var it = S.get('record', key);
    return !!(it && it.data.childId === childId);
  }
  function moveRecord(key, fromId, toId) {
    if (!key || fromId === toId) return;
    var it = S.get('record', key);
    if (!it || it.data.childId !== fromId) return;
    S.put('record', key, Object.assign({}, it.data, { childId: toId, updatedAt: new Date().toISOString() }));
  }
  function removeRecord(childId, key) {
    var it = S.get('record', key);
    if (it && it.data.childId === childId) S.remove('record', key);
  }

  /* 把某个孩子的全部记录合成「每个知识点现在的状态」：越新的记录越说了算。
   * 返回 { byId: { id: { status, recKey, at, label, root } } } */
  function latestStatus(childId, subject) {
    var recs = recordsOf(childId).filter(function (r) { return !subject || r.subject === subject; }).reverse();
    var by = {};
    recs.forEach(function (r) {
      var roots = {};
      (r.roots || []).forEach(function (id) { roots[id] = true; });
      var put = function (ids, status) {
        (ids || []).forEach(function (id) { by[id] = { status: status, recKey: r.key, at: r.savedAt, label: r.label, root: !!roots[id], subject: r.subject }; });
      };
      put(r.mastered, 'mastered');
      put(r.shaky, 'shaky');
      put(r.weak, 'weak');
    });
    return by;
  }

  window.CnmChildren = {
    GRADES: GRADES, TEXTBOOKS: TEXTBOOKS, MAX_CHILDREN: MAX_CHILDREN,
    list: list, get: get, current: current, setCurrent: setCurrent,
    add: add, update: update, remove: remove,
    recordsOf: recordsOf, saveRecord: saveRecord, hasRecord: hasRecord, moveRecord: moveRecord, removeRecord: removeRecord,
    latestStatus: latestStatus
  };
})();
