const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const auth = require('./auth');
const service = require('./service');
const localHttp = require('./local-http');
const platformCookie = require('./platform-cookie');
const botSlug = require('./bot-slug');

/** @param {{ botId?: string, port?: number }} [ctx] */
function formatLocalHttpError(e, target, ctx) {
  const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
  const msg = e instanceof Error ? e.message : String(e);
  const cause =
    e instanceof Error && e.cause instanceof Error
      ? e.cause.message
      : e instanceof Error && e.cause
        ? String(e.cause)
        : '';
  const base = [msg, cause].filter(Boolean).join(' — ');
  if (code === 'ECONNREFUSED') {
    const who =
      ctx && ctx.botId
        ? ` Registry ghi bot «${ctx.botId}» port ${ctx.port ?? '—'} nhưng không có process lắng nghe tại ${target}.`
        : ` Không kết nối được tại ${target}.`;
    return (
      `${base || 'ECONNREFUSED'} —${who} ` +
      'Vào admin Platform → Restart bot; trong container: `pm2 list`, `pm2 logs bot-<id>`. Bot phải ở trạng thái running và đã bind đúng PORT (PM2).'
    );
  }
  return base || msg || 'Lỗi gọi bot local';
}

const router = express.Router();

const uploadDir = path.join(__dirname, '..', 'data', 'platform-uploads');
const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      try {
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
      } catch (e) {
        cb(e);
      }
    },
    filename(_req, _file, cb) {
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
    },
  }),
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const n = (file.originalname || '').toLowerCase();
    if (!n.endsWith('.zip')) {
      return cb(new Error('Chỉ chấp nhận file .zip'));
    }
    cb(null, true);
  },
});

/** Zip + icon bắt buộc khi tạo bot (field: archive, icon). */
const uploadBotCreate = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      try {
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
      } catch (e) {
        cb(e);
      }
    },
    filename(_req, file, cb) {
      const rnd = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (file.fieldname === 'archive') cb(null, `${rnd}.zip`);
      else cb(null, `icon-${rnd}.bin`);
    },
  }),
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (file.fieldname === 'archive') {
      const n = (file.originalname || '').toLowerCase();
      if (!n.endsWith('.zip')) {
        return cb(new Error('Chỉ chấp nhận file .zip cho archive'));
      }
      return cb(null, true);
    }
    if (file.fieldname === 'icon') {
      const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].includes(
        file.mimetype
      );
      return cb(ok ? null : new Error('Icon chỉ PNG, JPEG, WebP, GIF, SVG'), ok);
    }
    return cb(new Error('Trường file không hợp lệ'), false);
  },
}).fields([
  { name: 'archive', maxCount: 1 },
  { name: 'icon', maxCount: 1 },
]);

/** Clone GitHub: multipart name, gitUrl, branch (text) + icon (file). */
const cloneIconUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      try {
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
      } catch (e) {
        cb(e);
      }
    },
    filename(_req, _file, cb) {
      cb(null, `clone-icon-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    },
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].includes(
      file.mimetype
    );
    cb(ok ? null : new Error('Icon chỉ PNG, JPEG, WebP, GIF, SVG'), ok);
  },
}).single('icon');

const iconOnlyUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      try {
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
      } catch (e) {
        cb(e);
      }
    },
    filename(_req, _file, cb) {
      cb(null, `icon-up-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    },
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].includes(
      file.mimetype
    );
    cb(ok ? null : new Error('Icon chỉ PNG, JPEG, WebP, GIF, SVG'), ok);
  },
}).single('icon');

function unlinkQuiet(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* */
  }
}

function safeJsonArray(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rawPlatformToken(req) {
  const h = req.headers.authorization || '';
  let token = h.replace(/^Bearer\s+/i, '').trim();
  if (!token) token = platformCookie.readPlatformTokenFromReq(req);
  return token;
}

function bearerSession(req) {
  return auth.verifyPlatformSession(rawPlatformToken(req));
}

function requirePlatformAuth(req, res, next) {
  const s = bearerSession(req);
  if (!s) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  req.platformUser = s;
  next();
}

/** Local token (không có `r`) hoặc admin / bot_admin → xem mọi bot & dùng menu quản trị. */
function platformUserSeesAllBots(user) {
  if (!user) return false;
  if (user.roleNames === null) return true;
  const roles = Array.isArray(user.roleNames) ? user.roleNames : [];
  return roles.includes('admin') || roles.includes('bot_admin');
}

function requirePlatformManageAccess(req, res, next) {
  const u = req.platformUser;
  if (!u) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  if (u.roleNames === null) return next();
  const roles = Array.isArray(u.roleNames) ? u.roleNames : [];
  if (roles.includes('admin') || roles.includes('bot_admin')) return next();
  return res.status(403).json({ success: false, message: 'Không có quyền quản trị bot' });
}

function botVisibleToUser(bot, user) {
  if (!bot) return false;
  if (!user) return false;
  if (platformUserSeesAllBots(user)) return true;
  const allow = Array.isArray(bot.allowedRoleNames) ? bot.allowedRoleNames : [];
  if (!allow.length) return true;
  const u = new Set(user.roleNames);
  return allow.some((r) => u.has(r));
}

function requireBotVisible(req, res, next) {
  const bot = service.getBot(req.params.id);
  if (!bot || !botVisibleToUser(bot, req.platformUser)) {
    return res.status(404).json({ success: false, message: 'Không tìm thấy bot' });
  }
  req.platformBot = bot;
  next();
}

router.get('/meta', (_req, res) => {
  res.json({
    success: true,
    authConfigured: auth.platformAuthConfigured(),
    authMode: auth.useBassoAdminAuth() ? 'basso' : 'local',
    manageTabPasswordRequired: auth.manageTabPasswordConfigured(),
    pythonTabPasswordRequired: auth.pythonTabPasswordConfigured(),
    roles: [
      { name: 'admin', label: 'Quản trị viên' },
      { name: 'bot_admin', label: 'Quản trị bot' },
      { name: 'order_manager', label: 'Quản lý đơn hàng' },
      { name: 'shop_manager', label: 'Quản lý sản phẩm' },
      { name: 'editor', label: 'Quản trị nội dung' },
      { name: 'customer', label: 'Khách hàng' },
      { name: 'web_order', label: 'Quản lý đơn admin' },
      { name: 'inventory_manager', label: 'Quản lý kho' },
      { name: 'accounting_manager', label: 'Kế toán' },
      { name: 'alerts.view', label: 'Xem thông báo' },
    ],
  });
});

router.use('/system', requirePlatformAuth, requirePlatformManageAccess);

/** Deploy key để add vào GitHub repo private (Deploy keys: Read-only). */
router.get('/system/git-public-key', (_req, res) => {
  try {
    const publicKey = service.getGitDeployPublicKey();
    res.json({ success: true, publicKey });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || String(e) });
  }
});

// --- Python bots (headless, chạy bằng python + venv + PM2 trong container Platform) ---
router.use('/python-bots', requirePlatformAuth, requirePlatformManageAccess);

router.get('/python-bots', async (_req, res) => {
  try {
    const bots = await service.listPythonBots();
    res.json({ success: true, bots });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || String(e) });
  }
});

router.post('/python-bots', express.json({ limit: '24kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const r = await service.createPythonBot({
      name: body.name,
      gitUrl: body.gitUrl,
      branch: body.branch,
      entrypoint: body.entrypoint,
    });
    res.status(202).json({ success: true, id: r.id });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || String(e) });
  }
});

router.post('/python-bots/:id/reload', async (req, res) => {
  const r = await service.reloadPythonBot(req.params.id);
  if (!r.ok) return res.status(400).json({ success: false, message: r.message || 'Reload lỗi' });
  res.json({ success: true });
});

router.get('/python-bots/:id/logs', async (req, res) => {
  const r = await service.getPythonBotPm2Logs(req.params.id, {
    lines: req.query.lines,
    which: req.query.which,
  });
  if (!r.ok) return res.status(400).json({ success: false, message: r.message });
  res.json({
    success: true,
    out: r.out,
    err: r.err,
    outPath: r.outPath,
    errPath: r.errPath,
    lines: r.lines,
    which: r.which,
  });
});

router.get('/python-bots/:id/env-wizard', (req, res) => {
  const r = service.getPythonBotEnvWizard(req.params.id);
  if (!r.ok) return res.status(400).json({ success: false, message: r.message });
  res.json({ success: true, ...r });
});

router.put('/python-bots/:id/env', express.json({ limit: '128kb' }), (req, res) => {
  const values = req.body && req.body.values && typeof req.body.values === 'object' ? req.body.values : {};
  const w = service.writePythonBotEnv(req.params.id, values);
  if (!w.ok) return res.status(400).json({ success: false, message: w.message });
  res.json({ success: true });
});

router.delete('/python-bots/:id', async (req, res) => {
  const r = await service.deletePythonBot(req.params.id);
  if (!r.ok) return res.status(404).json({ success: false, message: r.message || 'Không tìm thấy python bot' });
  res.json({ success: true });
});

router.post('/auth/login', express.json(), async (req, res) => {
  const { username, password } = req.body || {};
  const mode = auth.useBassoAdminAuth() ? 'basso' : 'local';
  const result = auth.useBassoAdminAuth()
    ? await auth.loginBasso(String(username || ''), String(password || ''))
    : auth.login(String(username || ''), String(password || ''));
  if (!result.ok) {
    const status =
      result.code === 'not_configured' ? 503 : result.code === 'upstream' ? 502 : 401;
    console.log('[platform/api] POST /auth/login failed', {
      mode,
      code: result.code,
      status,
      user: auth.maskEmail(String(username || '')),
    });
    return res.status(status).json({ success: false, message: result.message });
  }
  console.log('[platform/api] POST /auth/login ok', { mode, user: auth.maskEmail(String(username || '')) });
  platformCookie.setPlatformTokenCookie(res, result.token);
  const payload = { success: true, token: result.token };
  if (result.chatUser) payload.chatUser = result.chatUser;
  res.json(payload);
});

/** Xóa cookie phiên admin (kèm đăng xuất UI). */
router.post('/auth/logout', (_req, res) => {
  platformCookie.clearPlatformTokenCookie(res);
  res.json({ success: true });
});

/**
 * Gắn lại cookie HttpOnly từ Bearer hoặc cookie hợp lệ.
 * Trang /admin chỉ đọc cookie (không gửi Bearer khi tải HTML) — nếu user chỉ có token trong
 * localStorage, cần gọi endpoint này trước khi redirect dashboard để tránh vòng lặp login ↔ dashboard.
 */
router.post('/auth/sync-cookie', (req, res) => {
  const raw = rawPlatformToken(req);
  if (!raw || !auth.verifyToken(raw)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  platformCookie.setPlatformTokenCookie(res, raw);
  res.json({ success: true });
});

/** Kiểm tra token còn hợp lệ (Bearer hoặc cookie). */
router.get('/auth/session', requirePlatformAuth, (_req, res) => {
  res.json({ success: true, user: { username: _req.platformUser?.u || '', roles: _req.platformUser?.roleNames || [] } });
});

/**
 * Xác thực mật khẩu tab Quản lý bot (PLATFORM_MANAGE_TAB_PASSWORD).
 * Chỉ có tác dụng khi biến đó được cấu hình; client dùng kết hợp sessionStorage.
 */
router.post(
  '/auth/verify-manage',
  requirePlatformAuth,
  requirePlatformManageAccess,
  express.json({ limit: '4kb' }),
  (req, res) => {
    if (!auth.manageTabPasswordConfigured()) {
      return res.json({ success: true, skipped: true });
    }
    const password = req.body && req.body.password != null ? String(req.body.password) : '';
    if (!auth.verifyManageTabPassword(password)) {
      return res.status(401).json({ success: false, message: 'Sai mật khẩu' });
    }
    res.json({ success: true });
  }
);

/**
 * Xác thực mật khẩu tab Bot (Python) (PLATFORM_PYTHON_TAB_PASSWORD).
 * Client dùng kết hợp sessionStorage.
 */
router.post(
  '/auth/verify-python',
  requirePlatformAuth,
  requirePlatformManageAccess,
  express.json({ limit: '4kb' }),
  (req, res) => {
    if (!auth.pythonTabPasswordConfigured()) {
      return res.json({ success: true, skipped: true });
    }
    const password = req.body && req.body.password != null ? String(req.body.password) : '';
    if (!auth.verifyPythonTabPassword(password)) {
      return res.status(401).json({ success: false, message: 'Sai mật khẩu' });
    }
    res.json({ success: true });
  }
);

/** Đăng nhập chat (Basso) — public, proxy tới một bot đang chạy; client lưu ai_chat_user (localStorage) dùng chung mọi /b/{id}/ */
router.post('/auth/chat-login', express.json({ limit: '48kb' }), async (req, res) => {
  const candidates = service.getAuthProxyBotsOrdered();
  const emailHint = auth.maskEmail(String((req.body && req.body.email) || ''));
  if (!candidates.length) {
    console.log('[platform/api] POST /auth/chat-login 503: không có bot proxy đăng nhập', {
      email: emailHint,
      hint: 'Cần ít nhất 1 bot running hoặc PLATFORM_PROXY_AUTH_BOT_ID',
    });
    return res.status(503).json({
      success: false,
      message:
        'Chưa có bot để xác thực. Hãy tạo và chạy ít nhất một bot, hoặc đặt PLATFORM_PROXY_AUTH_BOT_ID trong .env.',
    });
  }

  let lastErr = null;
  let lastTarget = '';
  let lastBot = null;

  for (let i = 0; i < candidates.length; i++) {
    const bot = candidates[i];
    const target = `http://127.0.0.1:${bot.port}/api/basso-login`;
    lastBot = bot;
    lastTarget = target;
    if (auth.authDebugEnabled()) {
      console.log('[platform/api] chat-login → bot', { botId: bot.id, port: bot.port, target, email: emailHint });
    }
    try {
      const r = await localHttp.postJson(bot.port, '/api/basso-login', req.body || {});
      const text = r.text;
      if (auth.authDebugEnabled() || r.statusCode >= 400) {
        let summary = { httpStatus: r.statusCode };
        try {
          const j = JSON.parse(text);
          summary.bassoSuccess = j.success;
          summary.message = typeof j.message === 'string' ? j.message : undefined;
        } catch {
          summary.bodyPreview = text.slice(0, 300);
        }
        console.log('[platform/api] chat-login proxy response', summary);
      }
      return res
        .status(r.statusCode)
        .setHeader('Content-Type', 'application/json; charset=utf-8')
        .send(text);
    } catch (e) {
      lastErr = e;
      const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
      if (code === 'ECONNREFUSED' && i < candidates.length - 1) {
        console.warn('[platform/api] chat-login ECONNREFUSED, thử bot khác', { botId: bot.id, port: bot.port });
        continue;
      }
      break;
    }
  }

  console.log('[platform/api] chat-login proxy error', {
    err: lastErr instanceof Error ? lastErr.message : String(lastErr),
    code: lastErr && typeof lastErr === 'object' && 'code' in lastErr ? lastErr.code : undefined,
    target: lastTarget,
    lastBotId: lastBot && lastBot.id,
  });
  return res.status(502).json({
    success: false,
    message: formatLocalHttpError(lastErr, lastTarget, lastBot ? { botId: lastBot.id, port: lastBot.port } : undefined),
  });
});

/** get-roles qua bot có cùng cấu hình Basso — thử bot khác nếu ECONNREFUSED */
router.get('/auth/chat-get-roles', async (req, res) => {
  const candidates = service.getAuthProxyBotsOrdered();
  if (!candidates.length) {
    return res.status(503).json({ success: false, roles: [] });
  }
  const hAuth = req.headers.authorization || '';
  let lastErr = null;
  let lastTarget = '';
  let lastBot = null;

  for (let i = 0; i < candidates.length; i++) {
    const bot = candidates[i];
    const target = `http://127.0.0.1:${bot.port}/api/get-roles`;
    lastBot = bot;
    lastTarget = target;
    try {
      const r = await localHttp.getJson(bot.port, '/api/get-roles', hAuth ? { Authorization: hAuth } : {});
      return res
        .status(r.statusCode)
        .setHeader('Content-Type', 'application/json; charset=utf-8')
        .send(r.text);
    } catch (e) {
      lastErr = e;
      const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
      if (code === 'ECONNREFUSED' && i < candidates.length - 1) {
        console.warn('[platform/api] chat-get-roles ECONNREFUSED, thử bot khác', { botId: bot.id, port: bot.port });
        continue;
      }
      break;
    }
  }

  return res.status(502).json({
    success: false,
    roles: [],
    message: formatLocalHttpError(lastErr, lastTarget, lastBot ? { botId: lastBot.id, port: lastBot.port } : undefined),
  });
});

router.get('/bots', requirePlatformAuth, (req, res) => {
  const data = service.readRegistry();
  const base = service.getBotPublicBase(req);
  const allBots = Array.isArray(data.bots) ? data.bots : [];
  const bots = allBots
    .filter((b) => botVisibleToUser(b, req.platformUser))
    .map((b) => {
      const enabled = b.enabled !== false;
      const online = service.isBotOnline(b);
      const reachable = enabled && b.status === 'running' && b.id;
      const slug = botSlug.getCanonicalSlug(b, allBots);
      return {
        id: b.id,
        name: b.name,
        description: b.description != null ? String(b.description) : '',
        status: b.status,
        statusMessage: b.statusMessage || '',
        online,
        enabled,
        port: b.port,
        allowedRoleNames: Array.isArray(b.allowedRoleNames) ? b.allowedRoleNames : [],
        dept: b.dept || '',
        deptColor: b.deptColor || '',
        role: b.role || '',
        tasks: Array.isArray(b.tasks) ? b.tasks : [],
        slug: slug || null,
        chatUrl: reachable ? botSlug.buildChatUrl(base, b, allBots) : null,
        hasIcon: service.botHasIcon(b.id),
        updatedAt: b.updatedAt,
        createdBotAt: b.createdBotAt,
      };
    });
  res.json({ success: true, bots });
});

/** Log container Platform (docker logs) hoặc tail file PLATFORM_SYSTEM_LOG_PATH — tab admin «Logs hệ thống». */
router.get('/system/docker-logs', async (req, res) => {
  const r = await service.getPlatformSystemLogs({ lines: req.query.lines });
  if (!r.ok) {
    return res.status(400).json({
      success: false,
      message: r.message,
      hint: r.hint,
      containerTried: r.containerTried,
    });
  }
  res.json({
    success: true,
    text: r.text,
    source: r.source,
    container: r.container,
    path: r.path,
    lines: r.lines,
    note: r.note,
  });
});

router.get(
  '/bots/:id/logs',
  requirePlatformAuth,
  requirePlatformManageAccess,
  requireBotVisible,
  async (req, res) => {
  const r = await service.getBotPm2Logs(req.params.id, {
    lines: req.query.lines,
    which: req.query.which,
  });
  if (!r.ok) {
    const st = r.message.includes('Không tìm thấy bot') ? 404 : 400;
    return res.status(st).json({ success: false, message: r.message });
  }
  res.json({
    success: true,
    out: r.out,
    err: r.err,
    outPath: r.outPath,
    errPath: r.errPath,
    lines: r.lines,
    which: r.which,
  });
});

router.get('/bots/:id/icon', requirePlatformAuth, requireBotVisible, (req, res) => {
  const abs = service.getBotIconPath(req.params.id);
  if (!abs) return res.status(404).end();
  res.type(service.getBotIconMimeForPath(abs));
  res.sendFile(path.resolve(abs));
});

router.get('/bots/:id', requirePlatformAuth, requirePlatformManageAccess, requireBotVisible, (req, res) => {
  const bot = req.platformBot;
  const base = service.getBotPublicBase(req);
  const allBots = Array.isArray(service.readRegistry().bots) ? service.readRegistry().bots : [];
  const reachable = bot.status === 'running' && bot.id;
  res.json({
    success: true,
    bot: {
      ...bot,
      slug: botSlug.getCanonicalSlug(bot, allBots) || null,
      chatUrl: reachable ? botSlug.buildChatUrl(base, bot, allBots) : null,
      hasIcon: service.botHasIcon(bot.id),
    },
  });
});

/** Đọc server/.env.example + giá trị gợi ý cho wizard tạo server/.env */
router.get('/bots/:id/env-wizard', requirePlatformAuth, requirePlatformManageAccess, requireBotVisible, (req, res) => {
  const r = service.getBotEnvWizard(req.params.id);
  if (!r.ok) {
    const st = r.message && r.message.includes('Không tìm thấy') ? 404 : 400;
    return res.status(st).json({ success: false, message: r.message });
  }
  res.json({ success: true, ...r });
});

/** Ghi server/.env (chỉ các biến có trong .env.example). Mặc định restart PM2 sau khi ghi. */
router.put(
  '/bots/:id/env',
  requirePlatformAuth,
  requirePlatformManageAccess,
  requireBotVisible,
  express.json({ limit: '128kb' }),
  async (req, res) => {
    const values = req.body && req.body.values && typeof req.body.values === 'object' ? req.body.values : {};
    const w = service.writeBotEnv(req.params.id, values);
    if (!w.ok) {
      return res.status(400).json({ success: false, message: w.message });
    }
    const skipRestart = Boolean(req.body && req.body.skipRestart);
    if (skipRestart) {
      return res.json({ success: true, restarted: false });
    }
    const rr = await service.restartBot(req.params.id);
    if (!rr.ok) {
      return res.json({
        success: true,
        restarted: false,
        message: 'Đã ghi server/.env nhưng restart bot thất bại: ' + (rr.message || ''),
      });
    }
    res.json({ success: true, restarted: true });
  }
);

/** Clone repo GitHub — multipart: name, gitUrl, branch (text) + icon (file, bắt buộc). */
router.post('/bots/clone', requirePlatformAuth, requirePlatformManageAccess, (req, res, next) => {
  cloneIconUpload(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message || 'Upload lỗi' });
    }
    next();
  });
}, async (req, res) => {
  const body = req.body || {};
  const name = (body.name != null && String(body.name).trim()) || 'Unnamed bot';
  const description = body.description != null ? String(body.description) : '';
  const allowedRoleNames = auth.normalizeRoleNames(safeJsonArray(body.allowedRoleNames));
  const gitUrl = body.gitUrl;
  const branch = body.branch != null ? String(body.branch).trim() : '';
  if (!gitUrl || typeof gitUrl !== 'string' || !String(gitUrl).trim()) {
    unlinkQuiet(req.file && req.file.path);
    return res.status(400).json({ success: false, message: 'Thiếu gitUrl (HTTPS github.com/owner/repo)' });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Thiếu icon (field: icon)' });
  }
  try {
    const { id } = await service.enqueueProvisionFromGit({
      name,
      description,
      allowedRoleNames,
      gitUrl: String(gitUrl).trim(),
      branch,
      iconFile: req.file,
    });
    res.status(202).json({
      success: true,
      message: 'Đang clone → npm → pm2. Cần git trên server.',
      id,
    });
  } catch (e) {
    unlinkQuiet(req.file && req.file.path);
    res.status(400).json({ success: false, message: e.message || String(e) });
  }
});

router.post('/bots', requirePlatformAuth, requirePlatformManageAccess, (req, res, next) => {
  uploadBotCreate(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message || 'Upload lỗi' });
    }
    next();
  });
}, async (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : '').trim() || 'Unnamed bot';
  const description = req.body && req.body.description != null ? String(req.body.description) : '';
  const allowedRoleNames =
    req.body && req.body.allowedRoleNames ? auth.normalizeRoleNames(safeJsonArray(req.body.allowedRoleNames)) : [];
  const files = req.files || {};
  const arch = files.archive && files.archive[0];
  const iconF = files.icon && files.icon[0];
  if (!arch) {
    unlinkQuiet(iconF && iconF.path);
    return res.status(400).json({ success: false, message: 'Thiếu file server.zip (field: archive)' });
  }
  if (!iconF) {
    unlinkQuiet(arch.path);
    return res.status(400).json({ success: false, message: 'Thiếu icon (field: icon)' });
  }
  try {
    const { id } = await service.enqueueProvision({
      name,
      description,
      allowedRoleNames,
      zipPath: arch.path,
      iconFile: iconF,
    });
    res.status(202).json({
      success: true,
      message: 'Đang xử lý (giải nén → npm → pm2).',
      id,
    });
  } catch (e) {
    unlinkQuiet(arch.path);
    unlinkQuiet(iconF.path);
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post(
  '/bots/:id/icon',
  requirePlatformAuth,
  requirePlatformManageAccess,
  requireBotVisible,
  (req, res, next) => {
    iconOnlyUpload(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, message: err.message || 'Upload lỗi' });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Thiếu icon (field: icon)' });
    }
    const r = service.saveBotIconFromUpload(req.params.id, req.file);
    if (!r.ok) {
      const st = r.message && r.message.includes('tìm thấy') ? 404 : 400;
      return res.status(st).json({ success: false, message: r.message });
    }
    res.json({ success: true });
  }
);

/**
 * Upload source vào bot đã tồn tại (placeholder hoặc bot cũ muốn thay code).
 * Chỉ admin / bot_admin. Giữ nguyên metadata (tên, dept, tasks, icon).
 */
router.post(
  '/bots/:id/source',
  requirePlatformAuth,
  requirePlatformManageAccess,
  requireBotVisible,
  (req, res, next) => {
    upload.single('archive')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, message: err.message || 'Upload lỗi' });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Thiếu file server.zip (field: archive)' });
    }
    try {
      const { id } = await service.provisionExistingBot(req.params.id, req.file.path);
      res.status(202).json({
        success: true,
        message: 'Đã nhận source — đang giải nén & khởi động bot.',
        id,
      });
    } catch (e) {
      unlinkQuiet(req.file.path);
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes('Không tìm thấy bot') ? 404 : 400;
      res.status(status).json({ success: false, message: msg });
    }
  }
);

/**
 * Clone GitHub vào bot đã tồn tại (placeholder hoặc bot cũ muốn thay code).
 * Body JSON: { gitUrl, branch? }. Icon + tên + quyền giữ nguyên.
 */
router.post(
  '/bots/:id/source/git',
  requirePlatformAuth,
  requirePlatformManageAccess,
  requireBotVisible,
  express.json({ limit: '4kb' }),
  async (req, res) => {
    const body = req.body || {};
    const gitUrl = typeof body.gitUrl === 'string' ? body.gitUrl.trim() : '';
    const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
    if (!gitUrl) {
      return res.status(400).json({ success: false, message: 'Thiếu gitUrl (HTTPS github.com/owner/repo)' });
    }
    try {
      const { id } = await service.provisionExistingBotFromGit({ id: req.params.id, gitUrl, branch });
      res.status(202).json({
        success: true,
        message: 'Đang clone → npm → pm2. Cần git trên server.',
        id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes('Không tìm thấy bot') ? 404 : 400;
      res.status(status).json({ success: false, message: msg });
    }
  }
);

/**
 * Clone / re-clone bot từ GitHub.  Body JSON: { gitUrl?, branch? }.
 * Nếu `gitUrl` rỗng, dùng giá trị đã lưu trong registry (bot đã clone trước đó).
 * Nếu `branch` rỗng, dùng `gitBranch` đã lưu (hoặc branch mặc định của repo).
 * Lỗi 400 khi cả body và registry đều không có gitUrl.
 */
router.post(
  '/bots/:id/pull',
  requirePlatformAuth,
  requirePlatformManageAccess,
  requireBotVisible,
  express.json({ limit: '4kb' }),
  async (req, res) => {
    const body = req.body || {};
    const bodyGitUrl = typeof body.gitUrl === 'string' ? body.gitUrl.trim() : '';
    const bodyBranch = typeof body.branch === 'string' ? body.branch.trim() : '';
    const bot = req.platformBot;
    const storedGitUrl = bot && bot.gitUrl ? String(bot.gitUrl).trim() : '';
    const storedBranch = bot && bot.gitBranch ? String(bot.gitBranch).trim() : '';
    const gitUrl = bodyGitUrl || storedGitUrl;
    const branch = bodyBranch || storedBranch;
    if (!gitUrl) {
      return res.status(400).json({
        success: false,
        message: 'Nhập URL repo GitHub (HTTPS) hoặc clone lần đầu cho bot này trước.',
      });
    }
    try {
      const { id } = await service.provisionExistingBotFromGit({ id: req.params.id, gitUrl, branch });
      res.status(202).json({
        success: true,
        message: branch
          ? `Đang clone từ branch ${branch}.`
          : 'Đang clone từ branch mặc định.',
        id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes('Không tìm thấy bot') ? 404 : 400;
      res.status(status).json({ success: false, message: msg });
    }
  }
);

router.patch(
  '/bots/:id',
  requirePlatformAuth,
  requirePlatformManageAccess,
  requireBotVisible,
  express.json({ limit: '24kb' }),
  async (req, res) => {
  const body = req.body || {};
  const r = await service.updateBotProfile(req.params.id, {
    name: body.name !== undefined ? body.name : undefined,
    description: body.description !== undefined ? body.description : undefined,
    allowedRoleNames: body.allowedRoleNames !== undefined ? body.allowedRoleNames : undefined,
    dept: body.dept !== undefined ? body.dept : undefined,
    deptColor: body.deptColor !== undefined ? body.deptColor : undefined,
    role: body.role !== undefined ? body.role : undefined,
    tasks: body.tasks !== undefined ? body.tasks : undefined,
  });
  if (!r.ok) {
    const st = r.message.includes('tìm thấy') ? 404 : 400;
    return res.status(st).json({ success: false, message: r.message });
  }
  res.json({ success: true });
});

router.delete('/bots/:id', requirePlatformAuth, requirePlatformManageAccess, requireBotVisible, async (req, res) => {
  const r = await service.deleteBot(req.params.id);
  if (!r.ok) return res.status(404).json({ success: false, message: 'Không tìm thấy bot' });
  res.json({ success: true });
});

router.post('/bots/:id/reload', requirePlatformAuth, requirePlatformManageAccess, requireBotVisible, async (req, res) => {
  const r = await service.reloadBot(req.params.id);
  if (!r.ok) {
    return res.status(400).json({
      success: false,
      message: r.message || 'Không reload được',
      gitPulled: r.gitPulled,
    });
  }
  res.json({
    success: true,
    gitPulled: Boolean(r.gitPulled),
    message: r.gitPulled ? 'Đã git pull, npm, restart.' : 'Đã npm + restart (không có git).',
  });
});

router.post('/bots/:id/restart', requirePlatformAuth, requirePlatformManageAccess, requireBotVisible, async (req, res) => {
  const r = await service.restartBot(req.params.id);
  if (!r.ok) {
    return res.status(400).json({ success: false, message: r.message || 'Không restart được' });
  }
  res.json({ success: true });
});

/**
 * Admin bật/tắt bot trực tiếp từ dashboard.
 * Body: { online: true | false }
 *   - online=false → pm2 stop + enabled=false (watchdog sẽ skip, không auto-restart)
 *   - online=true  → pm2 restart/start + enabled=true
 */
router.post(
  '/bots/:id/online-toggle',
  requirePlatformAuth,
  requirePlatformManageAccess,
  requireBotVisible,
  express.json({ limit: '4kb' }),
  async (req, res) => {
    const wantOnline = Boolean(req.body && req.body.online);
    const r = await service.setBotEnabled(req.params.id, wantOnline);
    if (!r.ok) {
      const st = r.message && r.message.includes('Không tìm thấy') ? 404 : 400;
      return res.status(st).json({ success: false, message: r.message || 'Không đổi được trạng thái' });
    }
    res.json({ success: true, online: wantOnline });
  }
);

module.exports = router;
