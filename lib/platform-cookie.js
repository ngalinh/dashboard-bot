/** Cookie phiên đăng nhập admin — cùng tên với localStorage trong dashboard để đồng bộ. */
const COOKIE_NAME = 'platform_token';

/** Đồng bộ TTL với auth.issueToken (7 ngày). */
const MAX_AGE_SEC = 7 * 24 * 60 * 60;

/**
 * Chỉ bật cờ `Secure` khi bạn chỉ định rõ (HTTPS / reverse proxy TLS).
 * Không dùng NODE_ENV=production làm điều kiện: nhiều môi trường (Docker, LAN) vẫn là HTTP —
 * cookie Secure sẽ không được trình duyệt lưu → /admin không nhận phiên và bị kẹt vòng login ↔ dashboard.
 */
function cookieSecure() {
  return String(process.env.PLATFORM_COOKIE_SECURE || '').trim() === '1';
}

/** @param {import('express').Response} res */
function setPlatformTokenCookie(res, token) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(String(token || ''))}`,
    'Path=/',
    'Max-Age=' + MAX_AGE_SEC,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (cookieSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/** @param {import('express').Response} res */
function clearPlatformTokenCookie(res) {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (cookieSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/** @param {import('express').Request} req */
function readPlatformTokenFromReq(req) {
  const raw = req.headers && req.headers.cookie;
  if (!raw || typeof raw !== 'string') return '';
  const cookies = raw.split(';');
  for (const c of cookies) {
    const i = c.indexOf('=');
    if (i === -1) continue;
    const k = c.slice(0, i).trim();
    if (k === COOKIE_NAME) return decodeURIComponent(c.slice(i + 1).trim());
  }
  return '';
}

module.exports = {
  COOKIE_NAME,
  setPlatformTokenCookie,
  clearPlatformTokenCookie,
  readPlatformTokenFromReq,
};
