/* 账号与同步页：没登录时显示登录表单，登录后显示同步状态、立即同步、退出登录。 */
(function () {
  'use strict';
  var S = window.CnmSync;
  var $ = function (id) { return document.getElementById(id); };
  var loginCard = $('login-card'), accountCard = $('account-card');
  var userIn = $('l-user'), passIn = $('l-pass'), errBox = $('l-error'), submitBtn = $('l-submit');

  // 登录成功后回到来的地方（只接受站内相对路径）
  var back = new URLSearchParams(location.search).get('back');
  if (back && !/^\.\.?\//.test(back)) back = null;

  function show() {
    var on = S.loggedIn();
    loginCard.hidden = on;
    accountCard.hidden = !on;
    if (on) $('a-user').textContent = '账号：' + S.username();
  }
  function showError(msg) { errBox.textContent = msg || ''; errBox.hidden = !msg; }

  $('l-toggle').addEventListener('click', function () {
    var shown = passIn.type === 'text';
    passIn.type = shown ? 'password' : 'text';
    this.textContent = shown ? '显示' : '隐藏';
    this.setAttribute('aria-pressed', shown ? 'false' : 'true');
  });

  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var u = userIn.value.trim(), p = passIn.value;
    if (!u) { showError('请填写用户名。'); userIn.focus(); return; }
    if (!p) { showError('请填写密码。'); passIn.focus(); return; }
    showError('');
    submitBtn.disabled = true;
    submitBtn.textContent = '正在登录…';
    S.login(u, p).then(function () {
      passIn.value = '';
      if (back) { location.href = back; return; }
      show();
    }, function (err) {
      showError(err.status ? err.message : '连不上服务器，请检查网络后再试。');
      passIn.focus();
    }).then(function () {
      submitBtn.disabled = false;
      submitBtn.textContent = '登录';
    });
  });

  $('a-sync').addEventListener('click', function () { S.syncNow(); });

  $('a-logout').addEventListener('click', function () {
    var n = S.pendingCount();
    var msg = n
      ? '还有 ' + n + ' 项修改没传到服务器，退出会丢掉它们。确定退出？'
      : '退出后，这台设备上的档案和记录会清掉（服务器上的还在）。确定退出？';
    if (!confirm(msg)) return;
    S.logout().then(show);
  });

  window.addEventListener('cnm:sync', show);
  show();
  if (!S.loggedIn()) userIn.focus();
})();
