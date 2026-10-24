/* 部署相关配置。打包 APK 时由 mobile/build-www.mjs 重写本文件。 */

/* 同步服务器地址。网页版和接口同域，留空即可；APK 里要写完整地址（如 https://xuexi.example.com）。 */
window.CNM_API_BASE = window.CNM_API_BASE || '';

/* 没登录时是否要求先登录（默认要求）。设成 false 就退回「本机也能用，登录后同步」。 */
window.CNM_REQUIRE_LOGIN = true;
