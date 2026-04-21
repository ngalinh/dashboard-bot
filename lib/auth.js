const crypto = require('crypto');

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function authDebugEnabled() {
  return String(process.env.PLATFORM_AUTH_DEBUG || '').trim() === '1';
}

/** Ẩn email trong log (không log mật khẩu). */
function maskEmail(email) {
  const s = String(email || '').trim();
  if (!s) return '(trống)';
  const at = s.indexOf('@');
  if (at <= 0) return s.slice(0, 3) + '***';
  const user = s.slice(0, at);
  const dom = s.slice(at + 1);
  const u = user.length <= 2 ? user + '*' : user.slice(0, 2) + '***';
  return `${u}@${dom}`;
}

function authLog(msg, extra) {
  if (extra !== undefined) {
    console.log('[platform/auth]', msg, extra);
  } else {
    console.log('[platform/auth]', msg);
  }
}

function getSecret() {
  if (process.env.PLATFORM_SESSION_SECRET) return process.env.PLATFORM_SESSION_SECRET;
  if (process.env.PLATFORM_ADMIN_PASSWORD) return process.env.PLATFORM_ADMIN_PASSWORD;
  const hasBasso =
    Boolean((process.env.BASSO_URL || process.env.BASSO_BASE_URL || '').trim()) &&
    Boolean((process.env.BASSO_API_KEY || '').trim()) &&
    (process.env.BASSO_API_KEY || '').trim() !== 'your-basso-key-here';
  if (hasBasso) {
    console.warn(
      '[platform/auth] Đặt PLATFORM_SESSION_SECRET trong .env để ký token /admin khi chỉ đăng nhập qua Basso.'
    );
  }
  return 'dev-only-change-me';
}

function signPayload(payload) {
  const h = crypto.createHmac('sha256', getSecret());
  h.update(payload);
  return h.digest('base64url');
}

/** Chuẩn hoá roles (name) từ Basso: chỉ nhận string, trim, unique, sort. */
function normalizeRoleNames(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const x of input) {
    if (typeof x === 'string') {
      const s = x.trim();
      if (s) out.push(s);
      continue;
    }
    if (x && typeof x === 'object') {
      const name = x.name ?? x.role_name ?? x.roleName;
      if (typeof name === 'string') {
        const s = name.trim();
        if (s) out.push(s);
      }
    }
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string} username
 * @param {unknown} [roleNames] khi đăng nhập Basso: truyền user.roles (name); local admin: bỏ qua để token cũ vẫn hợp lệ.
 */
function issueToken(username, roleNames) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const withRoles = roleNames !== undefined;
  const r = withRoles ? normalizeRoleNames(roleNames) : undefined;
  const payloadForSig =
    withRoles && r !== undefined ? `${username}:${exp}:${JSON.stringify(r)}` : `${username}:${exp}`;
  const sig = signPayload(payloadForSig);
  const obj = { u: username, exp, sig };
  if (withRoles) obj.r = r;
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

/**
 * Verify token (tương thích token cũ).
 * @param {string | undefined} token
 * @returns {{ u: string, roleNames: string[] | null } | null}
 */
function verifyPlatformSession(token) {
  if (!token || typeof token !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const { u, exp, sig, r } = parsed;
  if (!u || typeof exp !== 'number' || !sig) return null;
  if (Date.now() > exp) return null;
  let payloadForSig;
  let roleNames = null;
  if (r !== undefined) {
    if (!Array.isArray(r)) return null;
    const rNorm = normalizeRoleNames(r);
    payloadForSig = `${u}:${exp}:${JSON.stringify(rNorm)}`;
    roleNames = rNorm;
  } else {
    payloadForSig = `${u}:${exp}`;
  }
  const expect = signPayload(payloadForSig);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  } catch {
    return null;
  }
  return { u: String(u), roleNames };
}

/** @param {string | undefined} token @returns {string | null} username */
function verifyToken(token) {
  const s = verifyPlatformSession(token);
  return s ? s.u : null;
}

/** URL gốc API Basso (không có / cuối). Ưu tiên BASSO_URL, sau đó BASSO_BASE_URL (đồng bộ với bot). */
function bassoPartnerBaseUrl() {
  const raw = (process.env.BASSO_URL || process.env.BASSO_BASE_URL || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

function bassoApiKey() {
  return String(process.env.BASSO_API_KEY || '').trim();
}

/** Đăng nhập /admin qua POST …/partner/login (cần BASSO_URL + BASSO_API_KEY). */
function useBassoAdminAuth() {
  const key = bassoApiKey();
  return Boolean(bassoPartnerBaseUrl() && key && key !== 'your-basso-key-here');
}

function platformAuthConfigured() {
  if (useBassoAdminAuth()) return true;
  return Boolean(process.env.PLATFORM_ADMIN_PASSWORD && process.env.PLATFORM_ADMIN_PASSWORD.length > 0);
}

/** Khi đặt PLATFORM_MANAGE_TAB_PASSWORD, tab Quản lý bot trên dashboard yêu cầu nhập thêm mật khẩu này (sau khi đã đăng nhập admin). */
function manageTabPasswordConfigured() {
  return String(process.env.PLATFORM_MANAGE_TAB_PASSWORD || '').length > 0;
}

/** Khi đặt PLATFORM_PYTHON_TAB_PASSWORD, tab «Bot (Python)» yêu cầu nhập thêm mật khẩu này (sau khi đã đăng nhập admin). */
function pythonTabPasswordConfigured() {
  return String(process.env.PLATFORM_PYTHON_TAB_PASSWORD || '').length > 0;
}

/**
 * So khớp mật khẩu tab Quản lý (không log).
 * @returns {boolean}
 */
function verifyManageTabPassword(password) {
  if (!manageTabPasswordConfigured()) return true;
  const expected = String(process.env.PLATFORM_MANAGE_TAB_PASSWORD || '');
  const got = String(password || '');
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(got, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function login(username, password) {
  if (!platformAuthConfigured()) {
    return {
      ok: false,
      code: 'not_configured',
      message:
        'Cấu hình BASSO_URL + BASSO_API_KEY (đăng nhập partner), hoặc PLATFORM_ADMIN_PASSWORD trong .env platform.',
    };
  }
  if (useBassoAdminAuth()) {
    return {
      ok: false,
      code: 'invalid',
      message: 'Đăng nhập admin đang dùng Basso; gọi loginBasso thay vì login.',
    };
  }
  const user = process.env.PLATFORM_ADMIN_USER || 'admin';
  if (username !== user) {
    authLog('Local login: sai user', { expectUser: user, got: maskEmail(username) });
    if (String(username).includes('@') && !useBassoAdminAuth()) {
      authLog(
        'Gợi ý: bạn đang nhập email nhưng platform chạy chế độ local. Thêm BASSO_URL + BASSO_API_KEY (vd. trong platform/.env hoặc Docker env) để đăng nhập qua Basso partner/login.'
      );
    }
    return { ok: false, code: 'invalid', message: 'Sai tài khoản hoặc mật khẩu' };
  }
  const expected = process.env.PLATFORM_ADMIN_PASSWORD;
  if (password !== expected) {
    authLog('Local login: sai mật khẩu');
    return { ok: false, code: 'invalid', message: 'Sai tài khoản hoặc mật khẩu' };
  }
  authLog('Local login OK', { user });
  return { ok: true, token: issueToken(username) };
}

/**
 * Đăng nhập partner Basso (cùng contract với bot: POST /partner/login, form urlencoded).
 * @param {string} email
 * @param {string} pass
 */
async function loginBasso(email, pass) {
  const base = bassoPartnerBaseUrl();
  const key = bassoApiKey();
  const url = `${base}/partner/login`;
  if (!base || !key || key === 'your-basso-key-here') {
    authLog('Basso login: thiếu cấu hình', { hasUrl: Boolean(base), hasKey: Boolean(key && key !== 'your-basso-key-here') });
    return {
      ok: false,
      code: 'not_configured',
      message: 'Đặt BASSO_URL và BASSO_API_KEY trong .env platform.',
    };
  }
  const t0 = Date.now();
  authLog('Basso partner/login request', { email: maskEmail(email), url, debug: authDebugEnabled() });
  try {
    const body = new URLSearchParams({
      email: String(email || ''),
      pass: String(pass || ''),
    }).toString();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Partner-Api-Key': key,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });
    const rawText = await response.text();
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
    let data = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { _parseError: true };
    }

    if (authDebugEnabled()) {
      authLog('Basso response', {
        httpStatus: response.status,
        contentType,
        ms: Date.now() - t0,
        jsonKeys: data && typeof data === 'object' && !data._parseError ? Object.keys(data) : [],
        successField: data?.success,
        hasAccessToken: Boolean(data?.data?.access_token),
        message: typeof data?.message === 'string' ? data.message : undefined,
        bodyPreview: data._parseError ? rawText.slice(0, 400) : undefined,
      });
    }

    if (data._parseError) {
      authLog('Basso login: body không phải JSON', { httpStatus: response.status, contentType, preview: rawText.slice(0, 200) });
      return {
        ok: false,
        code: 'upstream',
        message: `Basso trả về không phải JSON (${response.status}). Kiểm tra BASSO_URL và API.`,
      };
    }

    if (!response.ok) {
      authLog('Basso login: HTTP lỗi', { httpStatus: response.status, email: maskEmail(email) });
      return {
        ok: false,
        code: response.status >= 500 ? 'upstream' : 'invalid',
        message: data.message || `Basso HTTP ${response.status}`,
      };
    }
    if (!data || data.success !== true || !data.data?.access_token) {
      const msg =
        (typeof data.message === 'string' && data.message) ||
        (Array.isArray(data.errors) && data.errors[0] && (data.errors[0].message || data.errors[0])) ||
        'Sai email hoặc mật khẩu';
      authLog('Basso login: từ chối (success/access_token)', {
        email: maskEmail(email),
        success: data?.success,
        hasData: Boolean(data?.data),
      });
      return { ok: false, code: 'invalid', message: String(msg) };
    }
    const u = data.data.user || {};
    const principal = (u && (u.email || u.username)) || email || 'user';
    authLog('Basso login OK', { email: maskEmail(principal), ms: Date.now() - t0 });
    /** Cùng shape với `platform/public/login.html` → localStorage `ai_chat_user` dùng chung mọi bot. */
    const chatUser = {
      id: u.id,
      username: u.email || u.username || String(email || ''),
      name:
        u.name ||
        (u.first_name
          ? u.first_name + (u.last_name ? ' ' + u.last_name : '')
          : u.email || u.username || String(email || '')),
      token: data.data.access_token,
      expires_at: data.data.expires_at,
      roles: u.roles || [],
    };
    return { ok: true, token: issueToken(String(principal), u.roles), chatUser };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    authLog('Basso login exception', { email: maskEmail(email), err });
    return {
      ok: false,
      code: 'upstream',
      message: e instanceof Error ? e.message : 'Lỗi kết nối Basso',
    };
  }
}

/**
 * So khớp mật khẩu tab Bot (Python) (không log).
 * @returns {boolean}
 */
function verifyPythonTabPassword(password) {
  if (!pythonTabPasswordConfigured()) return true;
  const expected = String(process.env.PLATFORM_PYTHON_TAB_PASSWORD || '');
  const got = String(password || '');
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(got, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = {
  issueToken,
  verifyToken,
  verifyPlatformSession,
  normalizeRoleNames,
  login,
  loginBasso,
  platformAuthConfigured,
  useBassoAdminAuth,
  maskEmail,
  authDebugEnabled,
  manageTabPasswordConfigured,
  verifyManageTabPassword,
  pythonTabPasswordConfigured,
  verifyPythonTabPassword,
};
