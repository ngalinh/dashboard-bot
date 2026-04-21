/**
 * Phiên chat (`ai_chat_user`) + phiên admin Platform (`platform_token` + cookie HttpOnly)
 * cùng origin — đăng xuất một nơi nên xóa cả hai.
 */
(function (g) {
  var CHAT = 'ai_chat_user';
  var PLATFORM = 'platform_token';

  /**
   * @param {{ redirectTo?: string, redirect?: boolean }} [opts]
   *        redirectTo: mặc định 'login.html' (bot); admin dùng '/admin/login.html'
   *        redirect: false = chỉ xóa + gọi API, không chuyển trang
   */
  g.logoutChatAndPlatform = async function logoutChatAndPlatform(opts) {
    opts = opts || {};
    try {
      await fetch('/platform/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
      });
    } catch (e) {
      /* vẫn xóa storage */
    }
    try {
      g.localStorage.removeItem(CHAT);
      g.sessionStorage.removeItem(CHAT);
      g.localStorage.removeItem(PLATFORM);
    } catch (e) {
      /* */
    }
    if (opts.redirect !== false) {
      var to = opts.redirectTo != null ? opts.redirectTo : 'login.html';
      g.location.replace(to);
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
