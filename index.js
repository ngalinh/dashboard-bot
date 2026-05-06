require('dotenv').config();
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

const registry = require('./lib/registry');
const platformRoutes = require('./lib/routes');
const service = require('./lib/service');
const auth = require('./lib/auth');
const { ensurePlaceholderSeed } = require('./lib/placeholder-seed');
const { normalizeBotId } = require('./lib/bot-id');
const { readPlatformTokenFromReq } = require('./lib/platform-cookie');
const botSlug = require('./lib/bot-slug');

/** Chỉ cho phép tải /admin/* khi cookie phiên hợp lệ (trừ trang đăng nhập). */
function requireAdminStaticAuth(req, res, next) {
  const rel = req.path || '/';
  if (rel === '/login.html' || rel === '/login') return next();
  const tok = readPlatformTokenFromReq(req);
  if (auth.verifyToken(tok)) return next();
  const base = req.baseUrl || '/admin';
  const fullPath = base + (rel === '/' ? '' : rel);
  const qIndex = typeof req.url === 'string' ? req.url.indexOf('?') : -1;
  const qs = qIndex >= 0 ? req.url.slice(qIndex) : '';
  const nextTarget = (fullPath + qs).startsWith('/admin') ? fullPath + qs : '/admin/dashboard.html';
  res.redirect(302, '/admin/login.html?next=' + encodeURIComponent(nextTarget));
}

/** Agent / port để tái sử dụng TCP (keep-alive) tới từng bot — giảm overhead khi nhiều request. */
const botAgents = new Map();
function agentForBotPort(port) {
  const key = String(port);
  if (!botAgents.has(key)) {
    botAgents.set(
      key,
      new http.Agent({
        keepAlive: true,
        keepAliveMsecs: 65_000,
        maxSockets: 64,
        maxFreeSockets: 10,
      })
    );
  }
  return botAgents.get(key);
}

const app = express();
app.use(cors());
/**
 * IMPORTANT: Không parse JSON global.
 * Request tới /b/{botId} sẽ được proxy stream sang bot; nếu body bị đọc trước (express.json),
 * http-proxy-middleware có thể không forward body nguyên vẹn → pending/timeout.
 *
 * JSON parsing chỉ áp dụng cho API của Platform.
 */
app.use('/platform/api', express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'platform' });
});

/** Trang chủ domain — vào dashboard (đặt PLATFORM_ROOT_REDIRECT=0 để tắt) */
if (process.env.PLATFORM_ROOT_REDIRECT !== '0') {
  const rootTarget = process.env.PLATFORM_ROOT_REDIRECT || '/admin/dashboard.html';
  app.get('/', (_req, res) => res.redirect(302, rootTarget));
}

app.use('/platform/api', platformRoutes);

app.get('/admin', (_req, res) => {
  res.redirect('/admin/dashboard.html');
});
app.use('/admin', requireAdminStaticAuth, express.static(path.join(__dirname, 'admin')));

/** Đăng nhập chat chung: /login.html (localStorage `ai_chat_user` dùng cho mọi bot /b/{id}/) */
const publicDir = path.join(__dirname, 'public');
app.get('/login.html', (_req, res, next) => {
  res.sendFile(path.join(publicDir, 'login.html'), (err) => (err ? next(err) : undefined));
});
app.use(express.static(publicDir));

/**
 * URL đẹp theo tên bot: /doraemon/ → redirect 302 sang /b/<id>/ canonical.
 *
 * Tại sao redirect chứ không rewrite nội bộ: nhiều bot hardcode pattern
 * `/b/<id>/...` trong JS frontend, lấy <id> bằng cách parse window.location.
 * Nếu rewrite nội bộ, bot sẽ thấy URL trong address bar là /<slug>/, parse
 * sai botId → API call vỡ → 404. Redirect để browser thấy URL canonical
 * trước khi load HTML → bot's JS đọc /b/<id>/ chuẩn.
 *
 * Trade-off: address bar hiện /b/<id>/ thay vì /<slug>/ sau khi load. URL
 * /<slug>/ vẫn dùng được để chia sẻ (auto-redirect).
 *
 * Cho non-GET (POST/PUT/...) — vẫn rewrite nội bộ để tránh việc 302 + browser
 * convert POST→GET (RFC undefined behaviour) phá API call. Trường hợp này
 * hiếm xảy ra vì sau redirect browser đã ở URL canonical.
 *
 * Reserved set + collision handling: xem lib/bot-slug.js.
 * Chạy SAU express.static để file public (sw.js, login.html, ...) ưu tiên hơn.
 */
app.use((req, res, next) => {
  const rawPath = typeof req.path === 'string' ? req.path : '';
  if (!rawPath || rawPath === '/' || rawPath.length < 2) return next();
  const slashIdx = rawPath.indexOf('/', 1);
  const first = (slashIdx === -1 ? rawPath.slice(1) : rawPath.slice(1, slashIdx)).toLowerCase();
  if (!first || botSlug.isReservedSlug(first)) return next();
  let bots;
  try {
    bots = registry.readRegistry().bots;
  } catch {
    return next();
  }
  const bot = botSlug.getBotBySlug(first, bots);
  if (!bot) return next();
  const restPath = slashIdx === -1 ? '/' : rawPath.slice(slashIdx) || '/';
  const qIdx = typeof req.url === 'string' ? req.url.indexOf('?') : -1;
  const qs = qIdx >= 0 ? req.url.slice(qIdx) : '';
  const target = `/b/${encodeURIComponent(bot.id)}${restPath}${qs}`;
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.redirect(302, target);
  }
  req.url = target;
  return next();
});

const botRouter = express.Router();

botRouter.param('botId', (req, res, next, raw) => {
  req.params.botId = normalizeBotId(raw) || String(raw || '').trim();
  next();
});

function botMissingPlainMessage(botId) {
  const id = String(botId || '(thiếu)');
  const hex = id.replace(/[^a-f0-9]/gi, '');
  const folder = hex ? path.join(service.BOTS_PARENT, hex) : '';
  const hasDisk = folder && fs.existsSync(folder);
  let hint =
    '\n\n→ So khớp ID với /admin (Dashboard / Quản lý bot).\n→ Registry: file data/bots-registry.json hoặc MySQL khi .env có MYSQL_HOST / MYSQL_DATABASE.';
  if (hasDisk) {
    hint =
      '\n\nThư mục data/bots/' +
      hex +
      ' vẫn có trên đĩa nhưng bot không có trong registry — thường do Platform dùng MySQL khác với lúc tạo bot, hoặc bản ghi đã xóa. Kiểm tra .env (compose prod vs dev) và volume ./data.';
  }
  return `Bot không tồn tại trong registry (id: ${id}).${hint}`;
}

/** index.html / login.html là file tĩnh — phục vụ trực tiếp từ disk (platform/public hoặc data/bots/{id}), không proxy qua Node bot. */
botRouter.get('/:botId/login.html', (req, res, next) => {
  const bot = service.getBot(req.params.botId);
  if (!bot) {
    return res.status(404).type('text/plain; charset=utf-8').send(botMissingPlainMessage(req.params.botId));
  }
  res.sendFile(path.join(publicDir, 'login.html'), (err) => (err ? next(err) : undefined));
});

function sendBotIndexHtml(req, res, next) {
  const bot = service.getBot(req.params.botId);
  if (!bot) {
    return res.status(404).type('text/plain; charset=utf-8').send(botMissingPlainMessage(req.params.botId));
  }
  const root = service.getBotUiRoot(bot);
  const indexPath = root ? path.join(root, 'index.html') : '';
  if (!root || !fs.existsSync(indexPath)) {
    return res.status(404).type('text/plain; charset=utf-8').send('Không tìm thấy index.html của bot.');
  }
  let html;
  try {
    html = fs.readFileSync(indexPath, 'utf8');
  } catch (e) {
    return next(e);
  }
  res.type('text/html; charset=utf-8').send(injectPlatformChrome(html));
}

/**
 * Inject script biến nút "Logout" có sẵn trong bot UI thành nút "Back" dẫn về
 * /admin/dashboard.html. Detect bằng text content (Logout / Log out / Đăng xuất)
 * hoặc onclick gọi `logoutChatAndPlatform`. Có MutationObserver cho bot dạng
 * SPA render UI sau khi load. Tắt bằng env PLATFORM_BOT_BACK_BUTTON=0.
 *
 * Cũng cleanup cái pill floating "__platform_back_btn" nếu còn cache từ phiên
 * bản trước (đã đổi cách).
 */
function injectPlatformChrome(html) {
  if (process.env.PLATFORM_BOT_BACK_BUTTON === '0') return html;
  const script = `<script id="__platform_chrome_inject">(function(){
  var DEST = '/admin/dashboard.html';
  var LABELS = ['logout', 'log out', 'đăng xuất', 'dang xuat', 'sign out'];
  function normText(el){
    return (el.textContent || '').replace(/[\\u2190\\u2192\\s\\u00a0]+/g, ' ').trim().toLowerCase();
  }
  function isLogout(el){
    if (!el || (el.tagName !== 'A' && el.tagName !== 'BUTTON')) return false;
    if (el.dataset.__platformBack === '1') return false;
    var t = normText(el);
    if (LABELS.indexOf(t) !== -1) return true;
    var onc = (el.getAttribute('onclick') || '').toLowerCase();
    if (onc.indexOf('logoutchatandplatform') !== -1) return true;
    if (onc.indexOf('logout(') !== -1) return true;
    return false;
  }
  function convert(el){
    if (!el || el.dataset.__platformBack === '1') return;
    el.dataset.__platformBack = '1';
    while (el.firstChild) el.removeChild(el.firstChild);
    el.style.display = 'inline-flex';
    el.style.flexDirection = 'column';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.lineHeight = '1';
    el.style.gap = '2px';
    var arrow = document.createElement('span');
    arrow.textContent = '\\u2192';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.style.fontSize = '15px';
    arrow.style.lineHeight = '1';
    arrow.style.fontWeight = '700';
    var label = document.createElement('span');
    label.textContent = 'Back';
    label.style.fontSize = '11px';
    label.style.lineHeight = '1';
    label.style.fontWeight = '600';
    label.style.letterSpacing = '0.02em';
    el.appendChild(arrow);
    el.appendChild(label);
    el.setAttribute('aria-label', 'Quay về Dashboard');
    if (el.tagName === 'A') {
      el.setAttribute('href', DEST);
      el.removeAttribute('target');
    }
    el.removeAttribute('onclick');
    el.addEventListener('click', function(ev){
      ev.preventDefault();
      ev.stopPropagation();
      window.location.assign(DEST);
    }, true);
  }
  function scan(root){
    if (!root || !root.querySelectorAll) return;
    var els = root.querySelectorAll('a, button');
    for (var i = 0; i < els.length; i++) if (isLogout(els[i])) convert(els[i]);
  }
  function start(){
    var oldPill = document.getElementById('__platform_back_btn');
    if (oldPill && oldPill.parentNode) oldPill.parentNode.removeChild(oldPill);
    scan(document);
    if (typeof MutationObserver !== 'function') return;
    var mo = new MutationObserver(function(muts){
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n && n.nodeType === 1) {
            if (isLogout(n)) convert(n);
            scan(n);
          }
        }
      }
    });
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();</script>`;
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, script + '</body>');
  return html + script;
}

botRouter.get('/:botId/index.html', sendBotIndexHtml);
botRouter.get('/:botId/', sendBotIndexHtml);
botRouter.get('/:botId', (req, res) => {
  res.redirect(302, `/b/${encodeURIComponent(req.params.botId)}/`);
});

/**
 * GET/HEAD: nếu path là file dưới thư mục UI bot (cùng nơi index.html) thì gửi từ đĩa — mọi tên file/subpath hợp lệ,
 * không cần whitelist theo từng bot. Không có file → next() (proxy). Chặn segment nhạy cảm (server/, node_modules, …).
 */
const BOT_UI_STATIC_DENY_SEG = new Set(['server', 'node_modules', '.git', '.svn', '.env', '.hg']);

function botUiStaticRelativeSafe(relRaw) {
  if (typeof relRaw !== 'string') return null;
  const withoutLeading = relRaw.replace(/^\/+/, '');
  if (!withoutLeading) return '';
  const parts = withoutLeading.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null;
    if (BOT_UI_STATIC_DENY_SEG.has(part.toLowerCase())) return null;
    if (part.startsWith('.') && part.toLowerCase() !== '.well-known') return null;
  }
  return withoutLeading;
}

function tryServeBotUiStatic(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const botId = req.params.botId;
  const bot = service.getBot(botId);
  if (!bot) return next();
  const prefix = '/' + botId;
  const p = typeof req.path === 'string' ? req.path : '';
  const relFromPath = p.startsWith(prefix + '/') ? p.slice(prefix.length + 1) : '';
  const safeRel = botUiStaticRelativeSafe(relFromPath);
  if (safeRel === null) {
    return res.status(403).type('text/plain; charset=utf-8').send('Forbidden');
  }
  if (!safeRel) return next();
  const root = service.getBotUiRoot(bot);
  if (!root) return next();
  const resolved = path.resolve(path.join(root, safeRel));
  const rootResolved = path.resolve(root);
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    return res.status(403).end();
  }
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    return next();
  }
  if (!st.isFile()) return next();
  res.sendFile(resolved, (err) => (err ? next(err) : undefined));
}

botRouter.use('/:botId', tryServeBotUiStatic);
botRouter.use('/:botId', (req, res, next) => {
  const botId = req.params.botId;
  const bot = service.getBot(botId);
  if (!bot) {
    return res.status(404).type('text/plain; charset=utf-8').send(botMissingPlainMessage(botId));
  }
  if (bot.status !== 'running' || !bot.port) {
    return res
      .status(503)
      .type('text/plain; charset=utf-8')
      .send(
        `Bot «${botId}» chưa chạy (trạng thái: ${bot.status || 'unknown'}). Vào /admin → Quản lý bot → Restart hoặc xem log PM2.`
      );
  }
  /** API và asset động — proxy tới bot; bỏ tiền tố /b/{id} (không phân biệt hoa/thường trong URL). */
  const stripBotPrefix = (reqPath) => {
    if (typeof reqPath !== 'string' || !botId) return reqPath;
    const full = `/b/${botId}`;
    if (
      reqPath.length >= full.length &&
      reqPath.slice(0, full.length).toLowerCase() === full.toLowerCase() &&
      (reqPath.length === full.length || reqPath[full.length] === '/')
    ) {
      const rest = reqPath.slice(full.length) || '/';
      return rest.startsWith('/') ? rest : `/${rest}`;
    }
    const local = `/${botId}`;
    if (
      reqPath.length >= local.length &&
      reqPath.slice(0, local.length).toLowerCase() === local.toLowerCase() &&
      (reqPath.length === local.length || reqPath[local.length] === '/')
    ) {
      const rest = reqPath.slice(local.length) || '/';
      return rest.startsWith('/') ? rest : `/${rest}`;
    }
    return reqPath;
  };
  const proxy = createProxyMiddleware({
    target: `http://127.0.0.1:${bot.port}`,
    changeOrigin: true,
    ws: true,
    agent: agentForBotPort(bot.port),
    pathRewrite: (reqPath, req) => stripBotPrefix(reqPath || req.url || ''),
    /**
     * Log lỗi proxy rõ ràng (upstream down/reset/timeout…).
     * Tránh trường hợp client thấy pending mà không biết nguyên nhân.
     */
    proxyTimeout: 15_000,
    timeout: 20_000,
    onError(err, req, res) {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[platform/proxy]', 'bot request failed', {
        botId,
        target: `http://127.0.0.1:${bot.port}`,
        method: req.method,
        url: req.originalUrl || req.url,
        code: code || undefined,
        message: msg,
      });
      if (res.headersSent) return;
      const isTimeout =
        code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timeout/i.test(msg || '');
      res
        .status(isTimeout ? 504 : 502)
        .type('text/plain; charset=utf-8')
        .send(isTimeout ? 'Gateway Timeout (bot upstream)' : 'Bad Gateway (bot upstream)');
    },
    onProxyReq(_proxyReq, req) {
      // Ghi log request proxy cho debug khi cần (không log body).
      if (process.env.PLATFORM_PROXY_DEBUG === '1') {
        console.log('[platform/proxy]', '→ bot', {
          botId,
          method: req.method,
          url: req.originalUrl || req.url,
          target: `http://127.0.0.1:${bot.port}`,
        });
      }
    },
    onProxyRes(proxyRes, req) {
      if (process.env.PLATFORM_PROXY_DEBUG === '1') {
        console.log('[platform/proxy]', '← bot', {
          botId,
          method: req.method,
          url: req.originalUrl || req.url,
          statusCode: proxyRes.statusCode,
        });
      }
    },
  });
  proxy(req, res, next);
});
app.use('/b', botRouter);

const PORT = parseInt(process.env.PORT || '3980', 10);

(async function start() {
  try {
    await registry.init();
    // python bots registry (fs hoặc mysql)
    try {
      const pyRegistry = require('./lib/python-registry');
      await pyRegistry.init();
    } catch (e) {
      console.error('[platform] Python registry init failed:', e.message || e);
      process.exit(1);
    }
  } catch (e) {
    console.error('[platform] Registry init failed:', e.message);
    process.exit(1);
  }
  service.ensureDirs();
  try {
    await ensurePlaceholderSeed();
  } catch (e) {
    console.error('[platform] Placeholder seed failed:', e.message || e);
  }
  app.listen(PORT, () => {
    console.log(`[platform] http://localhost:${PORT}`);
    console.log(`[platform] Admin UI: http://localhost:${PORT}/admin/dashboard.html`);
    service.startBotHealthWatchdog();
    /**
     * Resurrect bot SAU khi /health đã sẵn sàng: container restart sẽ giết PM2
     * daemon → mọi bot chết theo. Watchdog phục hồi chậm (~3 phút/bot vì
     * cooldown), nên kích hoạt 1 lượt pm2 start ngay. Phải chạy fire-and-forget
     * SAU app.listen vì mỗi `pm2 start` tốn ~2–3s × N bot có thể vượt healthcheck
     * timeout của deploy script. Lỗi không cản platform.
     */
    setImmediate(() => {
      service.ensureBotsRunning().catch((e) => {
        console.error('[platform] ensureBotsRunning failed:', e.message || e);
      });
    });
  });
})();
