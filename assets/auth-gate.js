/* 登录门禁：没登录就跳到账号页，登录后回到原来的页面。
 * 只看本机有没有登录凭证，不去问服务器；凭证过期时接口会返回 401，sync.js 会清掉它。
 * 想退回「不登录也能用」：把 sync-config.js 里的 CNM_REQUIRE_LOGIN 改成 false。 */
(function () {
  'use strict';
  if (window.CNM_REQUIRE_LOGIN === false) return;

  var script = document.currentScript;
  var root = script && script.src ? new URL('../../', script.src).href : new URL('/', location.href).href;
  var here = location.pathname + location.search + location.hash;
  if (new URL('account/index.html', root).pathname === location.pathname) return;

  var authed = false;
  try {
    var a = JSON.parse(localStorage.getItem('cnmAuth.v1'));
    authed = !!(a && a.token);
  } catch (e) { /* 隐私模式：当作没登录 */ }

  if (!authed) location.replace(new URL('account/index.html?back=' + encodeURIComponent(here), root).href);
})();
