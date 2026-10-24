/* 同步状态显示：把状态写进页面上所有 [data-sync-status] 元素；别的设备改过的内容覆盖本机时弹一条提示。 */
(function () {
  'use strict';
  var S = window.CnmSync;
  if (!S) return;

  function hhmm(iso) {
    var d = new Date(iso);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function text(st) {
    switch (st.status) {
      case 'local': return st.error || '未登录：档案只存在这台设备上。';
      case 'syncing': return '正在同步…';
      case 'synced': return '已同步' + (st.lastSyncAt ? ' · ' + hhmm(st.lastSyncAt) : '');
      case 'pending': return '有 ' + st.pending + ' 项待同步';
      case 'offline': return (st.error || '连不上服务器。') + (st.pending ? '（' + st.pending + ' 项待同步）' : '');
      default: return '已登录：' + S.username();
    }
  }
  function render(st) {
    document.querySelectorAll('[data-sync-status]').forEach(function (box) {
      box.textContent = '';
      box.className = 'sync-status is-' + st.status;
      var dot = document.createElement('span');
      dot.className = 'sync-dot';
      dot.setAttribute('aria-hidden', 'true');
      var msg = document.createElement('span');
      msg.textContent = text(st);
      box.append(dot, msg);
      var href = box.getAttribute('data-account-href');
      if (href) {
        var a = document.createElement('a');
        a.href = href;
        a.textContent = S.loggedIn() ? '账号与同步' : '登录';
        box.append(a);
      }
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('sync-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'sync-toast';
      t.className = 'sync-toast';
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4500);
  }

  window.addEventListener('cnm:sync', function (e) {
    render(e.detail);
    if (e.detail.conflicts && e.detail.conflicts.length) {
      toast(e.detail.conflicts.length + ' 项在其他设备上改过或删掉了，已换成那边的版本。');
    }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { render(S.status()); });
  else render(S.status());
})();
