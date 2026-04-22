const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const util = require('util');
const AdmZip = require('adm-zip');

const registry = require('./registry');
const auth = require('./auth');
const { requestLocal } = require('./local-http');
const pyRegistry = require('./python-registry');

const execFileAsync = util.promisify(execFile);

const BOTS_PARENT = path.join(__dirname, '..', 'data', 'bots');

/** Log triển khai/reload bot (git, npm) — xem stdout Docker/PM2 của process Platform. */
function botOpLog(botId, kind, message, extra) {
  const id = String(botId || '(bot)');
  const prefix = `[platform/bot ${id}] [${kind}] ${message}`;
  if (extra !== undefined && extra !== null && typeof extra === 'object' && Object.keys(extra).length) {
    console.log(prefix, extra);
  } else {
    console.log(prefix);
  }
}

const BOT_ICONS_DIR = path.join(__dirname, '..', 'data', 'platform-bot-icons');
const PLATFORM_KEYS_DIR = path.join(__dirname, '..', 'data', 'platform-keys');
const PY_BOTS_PARENT = path.join(__dirname, '..', 'data', 'python-bots');
const ICON_VARIANT_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];
const ALLOWED_ICON_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
const ICON_EXT_FOR_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

function ensureDirs() {
  const dataRoot = path.join(__dirname, '..', 'data');
  [BOTS_PARENT, PY_BOTS_PARENT, path.join(dataRoot, 'platform-uploads'), BOT_ICONS_DIR, PLATFORM_KEYS_DIR, dataRoot].forEach((d) => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function deployKeyPaths() {
  ensureDirs();
  return {
    priv: path.join(PLATFORM_KEYS_DIR, 'git_deploy_ed25519'),
    pub: path.join(PLATFORM_KEYS_DIR, 'git_deploy_ed25519.pub'),
  };
}

/**
 * Tạo SSH deploy key (ed25519) nếu chưa có.
 * @returns {{ ok: boolean, publicKey?: string, message?: string }}
 */
function ensureGitDeployKey() {
  const { priv, pub } = deployKeyPaths();
  try {
    if (fs.existsSync(priv) && fs.existsSync(pub)) {
      return { ok: true, publicKey: fs.readFileSync(pub, 'utf8').trim() };
    }
    // ssh-keygen -t ed25519 -N "" -f <path>
    fs.mkdirSync(path.dirname(priv), { recursive: true });
    // Best-effort remove partial files
    try { if (fs.existsSync(priv)) fs.unlinkSync(priv); } catch { /* */ }
    try { if (fs.existsSync(pub)) fs.unlinkSync(pub); } catch { /* */ }
    const { spawnSync } = require('child_process');
    const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', priv], { encoding: 'utf8' });
    if (r.status !== 0) {
      return { ok: false, message: (r.stderr || r.stdout || 'ssh-keygen failed').trim() };
    }
    // Restrict permissions
    try { fs.chmodSync(priv, 0o600); } catch { /* */ }
    try { fs.chmodSync(pub, 0o644); } catch { /* */ }
    return { ok: true, publicKey: fs.readFileSync(pub, 'utf8').trim() };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}

function getGitDeployPublicKey() {
  const r = ensureGitDeployKey();
  if (!r.ok) throw new Error(r.message || 'ensureGitDeployKey');
  return r.publicKey || '';
}

function getGitDeployPrivateKeyPath() {
  const r = deployKeyPaths();
  // Ensure key exists so file path is valid.
  const ok = ensureGitDeployKey();
  if (!ok.ok) throw new Error(ok.message || 'ensureGitDeployKey');
  return r.priv;
}

function newPyBotId() {
  return crypto.randomBytes(10).toString('hex');
}

function normalizeGithubSshUrl(gitUrl) {
  const s = String(gitUrl || '').trim();
  if (!s) throw new Error('Thiếu gitUrl');
  if (s.startsWith('git@')) return s;
  // Convert https://github.com/owner/repo(.git)? -> git@github.com:owner/repo.git
  const m = s.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (m) return `git@github.com:${m[1]}/${m[2]}.git`;
  throw new Error('gitUrl chỉ hỗ trợ git@github.com:owner/repo.git hoặc https://github.com/owner/repo');
}

function pyBotDirs(id) {
  ensureDirs();
  const root = path.join(PY_BOTS_PARENT, id);
  return {
    root,
    repo: path.join(root, 'repo'),
    venv: path.join(root, 'venv'),
  };
}

function getPythonBotEnvPaths(pyBot) {
  const repoDir = pyBot && pyBot.workDir ? path.resolve(String(pyBot.workDir)) : '';
  return {
    examplePath: repoDir ? path.join(repoDir, '.env.example') : null,
    envPath: repoDir ? path.join(repoDir, '.env') : null,
  };
}

function getPythonBotEnvWizard(pyBotId) {
  const bot = pyRegistry.get(pyBotId);
  if (!bot) return { ok: false, message: 'Không tìm thấy python bot' };
  if (!bot.workDir || !fs.existsSync(bot.workDir)) {
    return {
      ok: true,
      workDirReady: false,
      hasExample: false,
      variables: [],
      botStatus: bot.status || '',
    };
  }
  const { examplePath, envPath } = getPythonBotEnvPaths(bot);
  if (!examplePath || !fs.existsSync(examplePath)) {
    return {
      ok: true,
      workDirReady: true,
      hasExample: false,
      variables: [],
      botStatus: bot.status || '',
      message: 'Không có file .env.example trong repo python bot.',
    };
  }
  let templateVars;
  let rawTemplateCount = 0;
  try {
    const raw = parseEnvExampleFile(fs.readFileSync(examplePath, 'utf8'));
    rawTemplateCount = raw.length;
    templateVars = filterBotEnvTemplateEntries(raw);
  } catch (e) {
    return { ok: false, message: `Đọc .env.example: ${e.message}` };
  }
  if (!templateVars.length) {
    return {
      ok: true,
      workDirReady: true,
      hasExample: false,
      variables: [],
      botStatus: bot.status || '',
      message:
        rawTemplateCount > 0
          ? '.env.example không có biến hợp lệ.'
          : '.env.example rỗng hoặc không đúng định dạng KEY=VALUE.',
    };
  }
  let existing = {};
  if (envPath && fs.existsSync(envPath)) {
    try {
      existing = parseExistingEnvFile(fs.readFileSync(envPath, 'utf8'));
    } catch {
      /* */
    }
  }
  const variables = templateVars.map((v) => {
    const currentValue = resolveBotEnvValueForKey(v.key, v.exampleValue, existing);
    return {
      key: v.key,
      hint: v.hint,
      exampleValue: v.exampleValue,
      currentValue,
      needsUserInput: envValueLooksUnset(currentValue),
      sensitive: /PASSWORD|SECRET|TOKEN|API_KEY|_KEY$/i.test(v.key),
    };
  });
  return {
    ok: true,
    workDirReady: true,
    hasExample: templateVars.length > 0,
    variables,
    envFile: '.env',
    botStatus: bot.status || '',
  };
}

function writePythonBotEnv(pyBotId, valuesObj) {
  const bot = pyRegistry.get(pyBotId);
  if (!bot || !bot.workDir || !fs.existsSync(bot.workDir)) {
    return { ok: false, message: 'Python bot chưa có thư mục repo (workDir)' };
  }
  const { examplePath, envPath } = getPythonBotEnvPaths(bot);
  if (!examplePath || !fs.existsSync(examplePath)) {
    return { ok: false, message: 'Thiếu .env.example — không thể tạo .env an toàn' };
  }
  let templateVars;
  try {
    templateVars = filterBotEnvTemplateEntries(parseEnvExampleFile(fs.readFileSync(examplePath, 'utf8')));
  } catch (e) {
    return { ok: false, message: `Đọc .env.example: ${e.message}` };
  }
  if (!templateVars.length) {
    return { ok: false, message: '.env.example không có biến hợp lệ.' };
  }
  let existing = {};
  if (envPath && fs.existsSync(envPath)) {
    try {
      existing = parseExistingEnvFile(fs.readFileSync(envPath, 'utf8'));
    } catch {
      /* */
    }
  }
  const input = valuesObj && typeof valuesObj === 'object' ? valuesObj : {};
  const lines = [
    '# Tạo / cập nhật từ Platform admin (theo .env.example). Sửa trực tiếp file này khi cần.',
    '',
  ];
  for (const { key, exampleValue } of templateVars) {
    let val;
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      val = input[key] == null ? '' : String(input[key]);
    } else {
      val = resolveBotEnvValueForKey(key, exampleValue, existing);
    }
    lines.push(`${key}=${escapeEnvLineValue(val)}`);
  }
  lines.push('');
  try {
    fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
  return { ok: true, path: envPath };
}

async function pyVenvInstall(botId, repoDir, venvDir) {
  const t0 = Date.now();
  botOpLog(botId, 'py', 'bắt đầu: tạo venv + pip install', { repoDir });
  await execFileAsync('python3', ['-m', 'venv', venvDir], {
    cwd: repoDir,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  const pip = path.join(venvDir, 'bin', 'pip');
  await execFileAsync(pip, ['install', '-r', 'requirements.txt', '--quiet'], {
    cwd: repoDir,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  botOpLog(botId, 'py', 'xong: pip install -r requirements.txt', { ms: Date.now() - t0 });
}

function pm2NamePy(id) {
  return `pybot-${id}`;
}

async function pm2StartPython(pyId, repoDir, venvDir, entrypoint) {
  const name = pm2NamePy(pyId);
  await pm2Delete(name);
  const python = path.join(venvDir, 'bin', 'python3');
  const args = ['start', python, '--name', name, '--cwd', repoDir, '--', entrypoint];
  await execFileAsync('pm2', args, {
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    maxBuffer: 1024 * 1024,
  });
}

async function pm2RestartPython(pyId, repoDir, venvDir, entrypoint) {
  // Simple: restart by delete+start to ensure interpreter/path is correct.
  await pm2StartPython(pyId, repoDir, venvDir, entrypoint);
}

async function pm2LogsByName(name, options = {}) {
  let list;
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], {
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    });
    list = JSON.parse(stdout);
  } catch (e) {
    return { ok: false, message: e.message || 'Không đọc được pm2 jlist (PM2 đã cài?)' };
  }
  if (!Array.isArray(list)) {
    return { ok: false, message: 'Định dạng PM2 jlist không hợp lệ' };
  }
  const app = list.find((p) => {
    if (!p) return false;
    const n = p.name || (p.pm2_env && p.pm2_env.name);
    return n === name;
  });
  if (!app || !app.pm2_env) {
    return { ok: false, message: `Không tìm thấy process PM2 "${name}"` };
  }
  const outPath = app.pm2_env.pm_out_log_path;
  const errPath = app.pm2_env.pm_err_log_path;
  const lines = options.lines != null ? Number(options.lines) : 200;
  const which = options.which || 'both';
  const out = which === 'err' ? '' : await tailLogFile(outPath, lines);
  const err = which === 'out' ? '' : await tailLogFile(errPath, lines);
  return { ok: true, out, err, outPath, errPath, lines, which };
}

async function listPythonBots() {
  return pyRegistry.list();
}

async function createPythonBot(opts) {
  const name = String(opts.name || '').trim() || 'Python bot';
  const gitUrl = normalizeGithubSshUrl(opts.gitUrl);
  const branch = (opts.branch && String(opts.branch).trim()) || '';
  const entrypoint = (opts.entrypoint && String(opts.entrypoint).trim()) || 'bot.py';
  if (entrypoint.includes('..') || entrypoint.includes('/') || entrypoint.includes('\\')) {
    throw new Error('entrypoint không hợp lệ (chỉ tên file trong root repo, ví dụ bot.py)');
  }
  const id = newPyBotId();
  const dirs = pyBotDirs(id);
  fs.mkdirSync(dirs.root, { recursive: true });
  await pyRegistry.add({
    id,
    name,
    gitUrl,
    gitBranch: branch,
    entrypoint,
    workDir: dirs.repo,
    status: 'pending',
    statusMessage: '',
  });

  setImmediate(() => {
    provisionPythonBot(id).catch(async (e) => {
      botOpLog(id, 'py', 'provision exception', { message: e.message || String(e) });
      await pyRegistry.update(id, { status: 'error', statusMessage: e.message || String(e) });
    });
  });

  return { id };
}

async function provisionPythonBot(id) {
  const bot = pyRegistry.get(id);
  if (!bot) throw new Error('Không tìm thấy python bot');
  const dirs = pyBotDirs(id);
  await pyRegistry.update(id, { status: 'cloning', statusMessage: '' });
  // Clone repo
  if (fs.existsSync(dirs.repo)) {
    fs.rmSync(dirs.repo, { recursive: true, force: true });
  }
  const privKey = getGitDeployPrivateKeyPath();
  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: `ssh -i "${privKey}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
  };
  const args = ['clone', '--depth', '1'];
  if (bot.gitBranch) args.push('--branch', bot.gitBranch);
  args.push(bot.gitUrl, dirs.repo);
  botOpLog(id, 'git', `bắt đầu: git clone ${bot.gitBranch ? `--branch ${bot.gitBranch} ` : ''}${bot.gitUrl}`, {});
  await execFileAsync('git', args, { maxBuffer: 30 * 1024 * 1024, env: gitEnv });
  botOpLog(id, 'git', 'xong: git clone', { repo: dirs.repo });

  await pyRegistry.update(id, { status: 'installing', statusMessage: '' });
  await pyVenvInstall(id, dirs.repo, dirs.venv);
  await pyRegistry.update(id, { status: 'starting', statusMessage: '' });
  await pm2StartPython(id, dirs.repo, dirs.venv, bot.entrypoint);
  await pyRegistry.update(id, { status: 'running', statusMessage: '' });
}

async function reloadPythonBot(id) {
  const bot = pyRegistry.get(id);
  if (!bot) return { ok: false, message: 'Không tìm thấy python bot' };
  const dirs = pyBotDirs(id);
  if (!fs.existsSync(dirs.repo)) return { ok: false, message: 'Repo chưa tồn tại (chưa clone?)' };
  const privKey = getGitDeployPrivateKeyPath();
  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: `ssh -i "${privKey}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
  };
  botOpLog(id, 'py', 'bắt đầu reload python bot', { repo: dirs.repo });
  try {
    await pyRegistry.update(id, { status: 'syncing', statusMessage: '' });
    await execFileAsync('git', ['fetch', 'origin', '--prune'], { cwd: dirs.repo, maxBuffer: 30 * 1024 * 1024, env: gitEnv });
    const upstream = bot.gitBranch ? `origin/${bot.gitBranch}` : 'origin/HEAD';
    await execFileAsync('git', ['reset', '--hard', upstream], { cwd: dirs.repo, maxBuffer: 30 * 1024 * 1024, env: gitEnv });
    await execFileAsync('git', ['clean', '-fd'], { cwd: dirs.repo, maxBuffer: 30 * 1024 * 1024, env: gitEnv });
    await pyRegistry.update(id, { status: 'installing', statusMessage: '' });
    await pyVenvInstall(id, dirs.repo, dirs.venv);
    await pyRegistry.update(id, { status: 'starting', statusMessage: '' });
    await pm2StartPython(id, dirs.repo, dirs.venv, bot.entrypoint);
    await pyRegistry.update(id, { status: 'running', statusMessage: '' });
    botOpLog(id, 'py', 'xong reload python bot', {});
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await pyRegistry.update(id, { status: 'error', statusMessage: msg });
    botOpLog(id, 'py', 'lỗi reload python bot', { message: msg });
    return { ok: false, message: msg };
  }
}

async function getPythonBotPm2Logs(id, options = {}) {
  const name = pm2NamePy(id);
  return await pm2LogsByName(name, options);
}

async function deletePythonBot(id) {
  const bot = pyRegistry.get(id);
  if (!bot) return { ok: false, message: 'Không tìm thấy python bot' };
  const dirs = pyBotDirs(id);
  try {
    await pm2Delete(pm2NamePy(id));
  } catch {
    /* */
  }
  try {
    if (fs.existsSync(dirs.root)) {
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
  const removed = await pyRegistry.remove(id);
  return { ok: Boolean(removed) };
}

function ensureBotIconsDir() {
  if (!fs.existsSync(BOT_ICONS_DIR)) fs.mkdirSync(BOT_ICONS_DIR, { recursive: true });
}

function removeAllBotIconVariants(botId) {
  for (const ext of ICON_VARIANT_EXTS) {
    const p = path.join(BOT_ICONS_DIR, `${botId}.${ext}`);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* */
    }
  }
}

function getBotIconPath(botId) {
  for (const ext of ICON_VARIANT_EXTS) {
    const p = path.join(BOT_ICONS_DIR, `${botId}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function botHasIcon(botId) {
  return getBotIconPath(botId) != null;
}

function getBotIconMimeForPath(absPath) {
  const ext = path.extname(absPath).toLowerCase().replace(/^\./, '');
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * Lưu icon từ file tạm multer; xóa mọi icon cũ của bot.
 * @param {string} botId
 * @param {{ path: string, mimetype?: string } | null | undefined} file
 * @returns {{ ok: boolean, message?: string }}
 */
function saveBotIconFromUpload(botId, file) {
  if (!registry.getBot(botId)) {
    try {
      if (file && file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch {
      /* */
    }
    return { ok: false, message: 'Không tìm thấy bot' };
  }
  if (!file || !file.path || !fs.existsSync(file.path)) {
    return { ok: false, message: 'Thiếu file icon' };
  }
  const mime = String(file.mimetype || '').toLowerCase();
  if (!ALLOWED_ICON_MIMES.has(mime)) {
    try {
      fs.unlinkSync(file.path);
    } catch {
      /* */
    }
    return { ok: false, message: 'Icon chỉ chấp nhận PNG, JPEG, WebP, GIF, SVG' };
  }
  const ext = ICON_EXT_FOR_MIME[mime];
  ensureBotIconsDir();
  removeAllBotIconVariants(botId);
  const dest = path.join(BOT_ICONS_DIR, `${botId}.${ext}`);
  try {
    fs.renameSync(file.path, dest);
  } catch {
    try {
      fs.copyFileSync(file.path, dest);
      fs.unlinkSync(file.path);
    } catch (e) {
      try {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      } catch {
        /* */
      }
      return { ok: false, message: e.message || 'Không lưu được icon' };
    }
  }
  return { ok: true };
}

function newBotId() {
  return crypto.randomBytes(8).toString('hex');
}

const BOT_DESCRIPTION_MAX = 2000;

function sanitizeBotDescription(d) {
  const s = String(d ?? '').trim();
  if (s.length <= BOT_DESCRIPTION_MAX) return s;
  return s.slice(0, BOT_DESCRIPTION_MAX);
}

function pm2Name(botId) {
  return `bot-${botId}`;
}

function allocatePort() {
  const data = registry.readRegistry();
  const start = parseInt(process.env.BOT_PORT_START || '4100', 10);
  const used = new Set(data.bots.map((b) => b.port).filter(Boolean));
  let p = start;
  while (used.has(p) && p < start + 2000) p += 1;
  if (p >= start + 2000) throw new Error('Hết port trong dải BOT_PORT_START');
  return p;
}

/**
 * @param {string} extractRoot
 * @returns {string | null}
 */
function findBotWorkDir(extractRoot) {
  const tryRoot = (root) => {
    const serverPkg = path.join(root, 'server', 'package.json');
    if (fs.existsSync(serverPkg)) return path.join(root, 'server');
    const rootPkg = path.join(root, 'package.json');
    if (fs.existsSync(rootPkg)) return root;
    return null;
  };
  const direct = tryRoot(extractRoot);
  if (direct) return direct;
  // Zip kiểu một folder bọc ngoài (vd. example-chat-bot/…)
  let entries;
  try {
    entries = fs.readdirSync(extractRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  if (dirs.length === 1) {
    return tryRoot(path.join(extractRoot, dirs[0].name));
  }
  return null;
}

function safeExtractZip(buffer, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const destResolved = path.resolve(destDir);

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    let name = entry.entryName;
    if (Buffer.isBuffer(name)) name = name.toString('utf8');
    name = name.replace(/\\/g, '/').replace(/^\/+/, '');
    for (const seg of name.split('/')) {
      if (seg === '..' || seg === '') throw new Error('File zip không hợp lệ (path)');
    }
    const destPath = path.join(destDir, ...name.split('/'));
    const resolved = path.resolve(destPath);
    if (!resolved.startsWith(destResolved + path.sep) && resolved !== destResolved) {
      throw new Error('File zip không hợp lệ (traversal)');
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, entry.getData());
  }
}

/**
 * @param {string} workDir
 * @param {{ botId?: string, phase?: string }} [ctx]
 */
async function npmInstall(workDir, ctx = {}) {
  const hasLock = fs.existsSync(path.join(workDir, 'package-lock.json'));
  const args = hasLock ? ['ci', '--omit=dev'] : ['install', '--omit=dev'];
  const botId = ctx.botId;
  const phase = ctx.phase || '';
  const t0 = Date.now();
  if (botId) {
    botOpLog(botId, 'npm', `bắt đầu: npm ${args.join(' ')}`, {
      workDir,
      phase: phase || undefined,
      hasLock,
    });
  }
  try {
    await execFileAsync('npm', args, {
      cwd: workDir,
      env: { ...process.env, NODE_ENV: 'production' },
      maxBuffer: 20 * 1024 * 1024,
    });
    if (botId) {
      botOpLog(botId, 'npm', `xong: npm ${args.join(' ')}`, {
        ms: Date.now() - t0,
        workDir,
        phase: phase || undefined,
      });
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const stderr =
      err && typeof err === 'object' && 'stderr' in err && err.stderr != null
        ? String(err.stderr)
        : '';
    if (botId) {
      botOpLog(botId, 'npm', `lỗi: npm ${args.join(' ')}`, {
        ms: Date.now() - t0,
        workDir,
        phase: phase || undefined,
        message: err.message,
        stderrTail: stderr ? stderr.slice(Math.max(0, stderr.length - 4000)) : undefined,
      });
    }
    throw err;
  }
}

async function pm2Delete(name) {
  try {
    await execFileAsync('pm2', ['delete', name], { maxBuffer: 1024 * 1024 });
  } catch {
    /* không tồn tại */
  }
}

async function pm2Start(botId, workDir, port) {
  const name = pm2Name(botId);
  await pm2Delete(name);
  const botEnv = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
  };
  if (process.env.BOT_NODE_OPTIONS) {
    botEnv.NODE_OPTIONS = process.env.BOT_NODE_OPTIONS;
  }
  const pm2Args = ['start', 'npm', '--name', name, '--cwd', workDir];
  const memLimit = process.env.BOT_PM2_MAX_MEMORY?.trim();
  if (memLimit) {
    pm2Args.push('--max-memory-restart', memLimit);
  }
  pm2Args.push('--', 'start');
  await execFileAsync('pm2', pm2Args, {
    env: botEnv,
    maxBuffer: 1024 * 1024,
  });
}

/** Có process PM2 tên `bot-{id}` trong `pm2 jlist` hay không (không phụ thuộc parse lỗi CLI). */
async function pm2ProcessExists(botId) {
  const name = pm2Name(botId);
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], {
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    });
    const list = JSON.parse(stdout);
    if (!Array.isArray(list)) return false;
    return list.some((p) => {
      if (!p) return false;
      const n = p.name || (p.pm2_env && p.pm2_env.name);
      return n === name;
    });
  } catch {
    return false;
  }
}

/**
 * Restart nếu process đã có trong PM2; nếu chưa (container mới, pm2 kill, v.v.) thì `pm2 start`
 * lại như lúc triển khai — luôn cần workDir + port từ registry.
 */
async function pm2Restart(botId, workDir, port) {
  const name = pm2Name(botId);
  if (await pm2ProcessExists(botId)) {
    await execFileAsync('pm2', ['restart', name], { maxBuffer: 1024 * 1024, env: process.env });
    return;
  }
  if (workDir && port) {
    await pm2Start(botId, workDir, port);
    return;
  }
  throw new Error(
    `Process PM2 "${name}" không tồn tại; registry thiếu workDir hoặc port nên không thể khởi động lại.`
  );
}

/** Sau khi có thư mục mã (zip hoặc git): npm ci → pm2 */
async function finalizeProvision(id, workDir) {
  if (!workDir) {
    await registry.updateBot(id, {
      status: 'error',
      statusMessage: 'Không tìm thấy package.json (root hoặc server/)',
    });
    return;
  }
  await registry.updateBot(id, { status: 'installing', workDir });
  try {
    await npmInstall(workDir, { botId: id, phase: 'provision' });
  } catch (e) {
    await registry.updateBot(id, {
      status: 'error',
      statusMessage: `npm: ${e.message}`,
    });
    return;
  }
  const port = allocatePort();
  await registry.updateBot(id, { port, status: 'starting' });
  try {
    await seedInitialBotEnvFromPlatform(id);
  } catch (e) {
    console.warn('[platform] seedInitialBotEnvFromPlatform', id, e.message || e);
  }
  const envCheck = checkBotEnvReadyForStart(id);
  if (!envCheck.ok) {
    await registry.updateBot(id, {
      status: 'error',
      statusMessage: envCheck.message,
    });
    return;
  }
  try {
    await pm2Start(id, workDir, port);
  } catch (e) {
    await registry.updateBot(id, {
      status: 'error',
      statusMessage: `pm2: ${e.message}. Cần PM2 trên PATH (npm i -g pm2).`,
    });
    return;
  }
  await registry.updateBot(id, { status: 'running', statusMessage: '' });
}

function normalizePublicGithubCloneUrl(input) {
  const s = String(input || '').trim();
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('URL GitHub không hợp lệ');
  }
  if (u.protocol !== 'https:') throw new Error('Chỉ hỗ trợ HTTPS');
  if (u.hostname !== 'github.com') throw new Error('Chỉ hỗ trợ github.com');
  if (u.username || u.password) {
    throw new Error('Không nhập user/mật khẩu trong URL; dùng GITHUB_CLONE_TOKEN trong .env (private repo)');
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('Cần dạng https://github.com/chủ-sở-hữu/tên-repo');
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    throw new Error('Tên owner hoặc repo không hợp lệ');
  }
  return `https://github.com/${owner}/${repo}.git`;
}

function withGithubPatForClone(httpsGitUrl) {
  const pat = (process.env.GITHUB_CLONE_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  if (!pat) return httpsGitUrl;
  return httpsGitUrl.replace(
    /^https:\/\/github\.com\//,
    `https://x-access-token:${pat}@github.com/`
  );
}

function assertBranchName(branch) {
  if (!branch) return;
  if (branch.length > 255) throw new Error('Tên nhánh quá dài');
  if (/[\r\n\0]/.test(branch) || branch.includes('..')) throw new Error('Tên nhánh không hợp lệ');
}

async function runProvision(id, zipPath) {
  ensureDirs();
  const extractDir = path.join(BOTS_PARENT, id);
  try {
    await registry.updateBot(id, { statusMessage: '', status: 'extracting' });
    const buffer = fs.readFileSync(zipPath);
    if (buffer.length < 22) throw new Error('File zip quá nhỏ hoặc không hợp lệ');
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
    fs.mkdirSync(extractDir, { recursive: true });
    safeExtractZip(buffer, extractDir);

    const workDir = findBotWorkDir(extractDir);
    await finalizeProvision(id, workDir);
  } catch (e) {
    await registry.updateBot(id, { status: 'error', statusMessage: e.message || String(e) });
  } finally {
    try {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    } catch {
      /* */
    }
  }
}

/**
 * @param {{ name: string, zipPath: string, iconFile?: { path: string, mimetype?: string }, description?: string }} opts
 * @returns {Promise<{ id: string }>}
 */
async function enqueueProvision(opts) {
  ensureDirs();
  const { name, zipPath, iconFile, description, allowedRoleNames } = opts;
  if (!iconFile || !iconFile.path) {
    try {
      if (zipPath && fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    } catch {
      /* */
    }
    throw new Error('Thiếu icon (field: icon)');
  }
  const id = newBotId();
  await registry.addBot({
    id,
    name: name || `Bot ${id}`,
    description: sanitizeBotDescription(description),
    allowedRoleNames: auth.normalizeRoleNames(allowedRoleNames),
    status: 'pending',
    port: null,
    workDir: null,
    statusMessage: '',
  });
  const ir = saveBotIconFromUpload(id, iconFile);
  if (!ir.ok) {
    await registry.removeBot(id);
    try {
      if (zipPath && fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    } catch {
      /* */
    }
    throw new Error(ir.message || 'Lưu icon thất bại');
  }
  setImmediate(() => {
    runProvision(id, zipPath).catch(async (e) => {
      console.error('[platform] runProvision', id, e);
      await registry.updateBot(id, { status: 'error', statusMessage: e.message || String(e) });
    });
  });
  return { id };
}

/**
 * @param {string} id
 * @param {string} cloneUrl đã gắn PAT (nếu có), không log ra ngoài
 * @param {string} branch rỗng = default branch
 */
async function runProvisionFromGit(id, cloneUrl, branch) {
  ensureDirs();
  const dest = path.join(BOTS_PARENT, id);
  try {
    await registry.updateBot(id, { statusMessage: '', status: 'cloning' });
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    const args = ['clone', '--depth', '1'];
    if (branch) args.push('--branch', branch);
    args.push(cloneUrl, dest);
    await execFileAsync('git', args, {
      maxBuffer: 30 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const workDir = findBotWorkDir(dest);
    await finalizeProvision(id, workDir);
  } catch (e) {
    await registry.updateBot(id, { status: 'error', statusMessage: e.message || String(e) });
  }
}

/**
 * @param {{ name: string, gitUrl: string, branch?: string, iconFile?: { path: string, mimetype?: string }, description?: string }} opts
 * @returns {Promise<{ id: string }>}
 */
async function enqueueProvisionFromGit(opts) {
  const normalized = normalizePublicGithubCloneUrl(opts.gitUrl);
  const branch = (opts.branch && String(opts.branch).trim()) || '';
  assertBranchName(branch);
  const cloneUrl = withGithubPatForClone(normalized);
  ensureDirs();
  const { iconFile, description, allowedRoleNames } = opts;
  if (!iconFile || !iconFile.path) {
    throw new Error('Thiếu icon (field: icon)');
  }
  const id = newBotId();
  await registry.addBot({
    id,
    name: opts.name || `Bot ${id}`,
    description: sanitizeBotDescription(description),
    allowedRoleNames: auth.normalizeRoleNames(allowedRoleNames),
    status: 'pending',
    port: null,
    workDir: null,
    statusMessage: '',
  });
  const ir = saveBotIconFromUpload(id, iconFile);
  if (!ir.ok) {
    await registry.removeBot(id);
    throw new Error(ir.message || 'Lưu icon thất bại');
  }
  setImmediate(() => {
    runProvisionFromGit(id, cloneUrl, branch).catch(async (e) => {
      console.error('[platform] runProvisionFromGit', id, e);
      await registry.updateBot(id, { status: 'error', statusMessage: e.message || String(e) });
    });
  });
  return { id };
}

async function deleteBot(id) {
  const bot = registry.getBot(id);
  if (!bot) return { ok: false };
  await pm2Delete(pm2Name(id));
  const extractDir = path.join(BOTS_PARENT, id);
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
  removeAllBotIconVariants(id);
  const removed = await registry.removeBot(id);
  return { ok: removed };
}

async function restartBot(id) {
  const bot = registry.getBot(id);
  if (!bot || !bot.workDir || !bot.port) {
    return { ok: false, message: 'Bot chưa chạy thành công' };
  }
  const envCheck = checkBotEnvReadyForStart(id);
  if (!envCheck.ok) {
    return { ok: false, message: envCheck.message };
  }
  try {
    await pm2Restart(id, bot.workDir, bot.port);
    await registry.updateBot(id, { status: 'running', statusMessage: '' });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/**
 * pm2 stop — dừng process nhưng giữ entry (để admin có thể bật lại bằng pm2 restart).
 * Nếu process không tồn tại trong pm2 thì coi như stopped (no-op ok).
 */
async function pm2Stop(botId) {
  const name = pm2Name(botId);
  if (!(await pm2ProcessExists(botId))) return;
  try {
    await execFileAsync('pm2', ['stop', name], { maxBuffer: 1024 * 1024, env: process.env });
  } catch (e) {
    // nếu stop fail nhưng process tồn tại, thử delete + để registry đánh dấu stopped
    throw new Error(`pm2 stop failed: ${e.message || String(e)}`);
  }
}

/**
 * Admin toggle bot ONLINE/OFFLINE:
 *  - enabled=false  → pm2 stop + set status='stopped' + enabled=false (watchdog sẽ skip)
 *  - enabled=true   → pm2 restart/start + set status='running' + enabled=true
 *
 * @param {string} id
 * @param {boolean} enabled
 */
async function setBotEnabled(id, enabled) {
  const bot = registry.getBot(id);
  if (!bot) return { ok: false, message: 'Không tìm thấy bot' };

  if (!enabled) {
    // Tắt: pm2 stop + flag
    try {
      await pm2Stop(id);
    } catch (e) {
      return { ok: false, message: e.message };
    }
    // Reset health tracking để không lookup pre-disable result
    healthFailStreak.delete(id);
    lastHealthResult.delete(id);
    await registry.updateBot(id, { enabled: false, status: 'stopped', statusMessage: '' });
    return { ok: true };
  }

  // Bật: cần workDir + port như restartBot
  if (!bot.workDir || !bot.port) {
    return { ok: false, message: 'Bot chưa có workDir/port — chưa từng start thành công; cần deploy lại trước.' };
  }
  const envCheck = checkBotEnvReadyForStart(id);
  if (!envCheck.ok) {
    return { ok: false, message: envCheck.message };
  }
  try {
    await pm2Restart(id, bot.workDir, bot.port);
  } catch (e) {
    return { ok: false, message: e.message };
  }
  healthFailStreak.delete(id);
  lastHealthResult.delete(id);
  await registry.updateBot(id, { enabled: true, status: 'running', statusMessage: '' });
  return { ok: true };
}

async function gitResolveUpstreamRef(rootDir) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      cwd: rootDir,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const s = String(stdout || '').trim();
    if (s) return s;
  } catch {
    /* */
  }
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: rootDir,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const ref = String(stdout || '').trim(); // refs/remotes/origin/main
    const m = ref.match(/^refs\/remotes\/(.+)$/);
    if (m && m[1]) return m[1]; // origin/main
  } catch {
    /* */
  }
  return 'origin/HEAD';
}

async function gitForceSyncOrigin(rootDir, botId) {
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const tFetch = Date.now();
  botOpLog(botId, 'git', 'bắt đầu: git fetch origin --prune', { rootDir });
  try {
    await execFileAsync('git', ['fetch', 'origin', '--prune'], {
      cwd: rootDir,
      maxBuffer: 30 * 1024 * 1024,
      env: gitEnv,
    });
    botOpLog(botId, 'git', 'xong: git fetch origin --prune', { rootDir, ms: Date.now() - tFetch });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const stderr =
      err && typeof err === 'object' && 'stderr' in err && err.stderr != null
        ? String(err.stderr)
        : '';
    botOpLog(botId, 'git', 'lỗi: git fetch origin --prune', {
      rootDir,
      ms: Date.now() - tFetch,
      message: err.message,
      stderrTail: stderr ? stderr.slice(Math.max(0, stderr.length - 4000)) : undefined,
    });
    throw err;
  }

  const upstream = await gitResolveUpstreamRef(rootDir);
  const tReset = Date.now();
  botOpLog(botId, 'git', `bắt đầu: git reset --hard ${upstream}`, { rootDir, upstream });
  try {
    await execFileAsync('git', ['reset', '--hard', upstream], {
      cwd: rootDir,
      maxBuffer: 30 * 1024 * 1024,
      env: gitEnv,
    });
    let head = '';
    let branch = '';
    try {
      const { stdout: h } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: rootDir,
        maxBuffer: 1024 * 1024,
        env: gitEnv,
      });
      head = String(h || '').trim();
    } catch {
      /* */
    }
    try {
      const { stdout: b } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: rootDir,
        maxBuffer: 1024 * 1024,
        env: gitEnv,
      });
      branch = String(b || '').trim();
    } catch {
      /* */
    }
    botOpLog(botId, 'git', `xong: git reset --hard ${upstream}`, {
      rootDir,
      upstream,
      HEAD: head || undefined,
      branch: branch || undefined,
      ms: Date.now() - tReset,
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const stderr =
      err && typeof err === 'object' && 'stderr' in err && err.stderr != null
        ? String(err.stderr)
        : '';
    botOpLog(botId, 'git', `lỗi: git reset --hard ${upstream}`, {
      rootDir,
      upstream,
      ms: Date.now() - tReset,
      message: err.message,
      stderrTail: stderr ? stderr.slice(Math.max(0, stderr.length - 4000)) : undefined,
    });
    throw err;
  }

  const tClean = Date.now();
  botOpLog(botId, 'git', 'bắt đầu: git clean -fd', { rootDir });
  try {
    await execFileAsync('git', ['clean', '-fd'], {
      cwd: rootDir,
      maxBuffer: 30 * 1024 * 1024,
      env: gitEnv,
    });
    botOpLog(botId, 'git', 'xong: git clean -fd', { rootDir, ms: Date.now() - tClean });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const stderr =
      err && typeof err === 'object' && 'stderr' in err && err.stderr != null
        ? String(err.stderr)
        : '';
    botOpLog(botId, 'git', 'lỗi: git clean -fd', {
      rootDir,
      ms: Date.now() - tClean,
      message: err.message,
      stderrTail: stderr ? stderr.slice(Math.max(0, stderr.length - 4000)) : undefined,
    });
    throw err;
  }
}

/**
 * Tải mã mới (git: fetch + reset theo origin nếu là clone), cài dependency, restart PM2.
 * Bot zip: bỏ qua git, chỉ npm + restart.
 */
async function reloadBot(id) {
  const bot = registry.getBot(id);
  if (!bot || !bot.workDir || !bot.port) {
    return { ok: false, message: 'Bot chưa chạy thành công (cần workDir và port)' };
  }
  const rootDir = path.join(BOTS_PARENT, id);
  if (!fs.existsSync(bot.workDir)) {
    return { ok: false, message: 'Thư mục server không tồn tại' };
  }
  let gitPulled = false;
  botOpLog(id, 'reload', 'bắt đầu reload bot', { rootDir, workDir: bot.workDir, port: bot.port });
  try {
    if (fs.existsSync(path.join(rootDir, '.git'))) {
      await gitForceSyncOrigin(rootDir, id);
      gitPulled = true;
    } else {
      botOpLog(id, 'git', 'bỏ qua (không có .git — bot zip hoặc không phải clone)', { rootDir });
    }
    await npmInstall(bot.workDir, { botId: id, phase: 'reload' });
    const envCheck = checkBotEnvReadyForStart(id);
    if (!envCheck.ok) {
      botOpLog(id, 'reload', 'dừng: .env chưa sẵn sàng', { message: envCheck.message, gitPulled });
      return { ok: false, message: envCheck.message, gitPulled };
    }
    await pm2Restart(id, bot.workDir, bot.port);
    await registry.updateBot(id, { status: 'running', statusMessage: '' });
    botOpLog(id, 'reload', 'xong reload bot (pm2 restart)', { gitPulled });
    return { ok: true, gitPulled };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    botOpLog(id, 'reload', 'lỗi reload bot', { message: msg, gitPulled });
    return { ok: false, message: msg, gitPulled };
  }
}

function getBotPublicBase(req) {
  const fromEnv = process.env.PUBLIC_ORIGIN;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const host = req.get('host') || 'localhost';
  const proto = req.protocol || 'http';
  return `${proto}://${host}`;
}

/**
 * Các bot ứng viên để proxy Basso (ưu tiên PLATFORM_PROXY_AUTH_BOT_ID, sau đó mọi bot running).
 * Dùng khi proxy chat-login: thử lần lượt nếu port bị ECONNREFUSED (registry stale hoặc PM2 chết).
 */
function getAuthProxyBotsOrdered() {
  const preferId = (process.env.PLATFORM_PROXY_AUTH_BOT_ID || '').trim();
  const data = registry.readRegistry();
  const running = data.bots.filter((b) => b.status === 'running' && b.port);
  if (preferId) {
    const preferred = running.find((b) => b.id === preferId);
    if (preferred) {
      return [preferred, ...running.filter((b) => b.id !== preferId)];
    }
  }
  return running;
}

/** Bot đầu tiên trong danh sách ứng viên (tương thích code cũ). */
function getAuthProxyBot() {
  const list = getAuthProxyBotsOrdered();
  return list[0] || null;
}

/** Đọc N dòng cuối file log (fallback khi không có lệnh `tail`). */
function tailLinesFromFileSync(filePath, maxLines) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  try {
    const stat = fs.statSync(filePath);
    const chunk = Math.min(stat.size, 1024 * 1024);
    const start = Math.max(0, stat.size - chunk);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split(/\r?\n/);
      return lines.slice(-maxLines).join('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

async function tailLogFile(filePath, maxLines) {
  if (!filePath) return '';
  try {
    const { stdout } = await execFileAsync('tail', ['-n', String(maxLines), filePath], {
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    });
    return stdout;
  } catch {
    return tailLinesFromFileSync(filePath, maxLines);
  }
}

/**
 * Log stdout/stderr PM2 của bot (như `pm2 logs bot-{id} --lines N`).
 * @param {string} botId
 * @param {{ lines?: string|number, which?: 'out'|'err'|'both' }} options
 */
async function getBotPm2Logs(botId, options = {}) {
  if (!registry.getBot(botId)) return { ok: false, message: 'Không tìm thấy bot' };
  const name = pm2Name(botId);
  let list;
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], {
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    });
    list = JSON.parse(stdout);
  } catch (e) {
    return { ok: false, message: e.message || 'Không đọc được pm2 jlist (PM2 đã cài?)' };
  }
  if (!Array.isArray(list)) {
    return { ok: false, message: 'Định dạng PM2 jlist không hợp lệ' };
  }
  const app = list.find((p) => {
    if (!p) return false;
    const n = p.name || (p.pm2_env && p.pm2_env.name);
    return n === name;
  });
  if (!app) {
    return { ok: false, message: 'Không có process PM2 cho bot này (chưa chạy hoặc đã xóa)' };
  }
  const env = app.pm2_env || {};
  const outPath = env.pm_out_log_path || '';
  const errPath = env.pm_err_log_path || '';
  const n = Math.min(2000, Math.max(10, parseInt(String(options.lines || 200), 10) || 200));
  const which = ['out', 'err', 'both'].includes(options.which) ? options.which : 'both';
  let out = '';
  let err = '';
  if (which === 'out' || which === 'both') {
    out = await tailLogFile(outPath, n);
  }
  if (which === 'err' || which === 'both') {
    err = await tailLogFile(errPath, n);
  }
  return { ok: true, out, err, outPath, errPath, lines: n, which };
}

const DOCKER_CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function sanitizeDockerContainerRef(name) {
  const s = String(name || '').trim();
  if (!DOCKER_CONTAINER_NAME_RE.test(s)) return null;
  return s;
}

/**
 * Log container Platform (Docker) hoặc file tuỳ chọn — phục vụ tab «Logs hệ thống» trên admin.
 * @param {{ lines?: string|number }} options
 */
async function getPlatformSystemLogs(options = {}) {
  const lines = Math.min(2000, Math.max(50, parseInt(String(options.lines || 300), 10) || 300));
  const logPathRaw = (process.env.PLATFORM_SYSTEM_LOG_PATH || '').trim();

  async function fromFile() {
    if (!logPathRaw) return null;
    const abs = path.isAbsolute(logPathRaw) ? logPathRaw : path.join(process.cwd(), logPathRaw);
    if (!fs.existsSync(abs)) return null;
    const text = await tailLogFile(abs, lines);
    return {
      ok: true,
      text: text || '(trống)',
      source: 'file',
      path: abs,
      lines,
    };
  }

  async function fromDocker() {
    const explicit = sanitizeDockerContainerRef(process.env.PLATFORM_DOCKER_LOGS_CONTAINER);
    const host = sanitizeDockerContainerRef(os.hostname());
    const container = explicit || host;
    if (!container) {
      return {
        ok: false,
        message: 'Không xác định được tên container Docker (hostname không hợp lệ).',
        hint: 'Đặt PLATFORM_DOCKER_LOGS_CONTAINER=tên_container (vd. từ `docker ps --format {{.Names}}`).',
      };
    }
    try {
      const { stdout, stderr } = await execFileAsync(
        'docker',
        ['logs', container, '--tail', String(lines)],
        { maxBuffer: 4 * 1024 * 1024, timeout: 30000, env: process.env }
      );
      const out = stdout != null ? String(stdout) : '';
      const err = stderr != null ? String(stderr) : '';
      let text = out;
      if (err && err.trim()) {
        text = text ? `${text}\n${err}` : err;
      }
      return { ok: true, text: text || '(trống)', source: 'docker', container, lines };
    } catch (e) {
      const errMsg = e.stderr ? String(e.stderr) : e.message || String(e);
      return {
        ok: false,
        message: errMsg.trim() || 'docker logs thất bại',
        containerTried: container,
        hint:
          'Cần Docker CLI trên PATH và quyền gọi daemon (trên host hoặc gắn /var/run/docker.sock vào container + cài docker CLI). Hoặc đặt PLATFORM_SYSTEM_LOG_PATH= đường_dẫn file log để đọc tail.',
      };
    }
  }

  const d = await fromDocker();
  if (d.ok) return d;
  const f = await fromFile();
  if (f) {
    return {
      ...f,
      note: 'Docker không khả dụng — đang hiển thị nội dung từ PLATFORM_SYSTEM_LOG_PATH.',
    };
  }
  return d;
}

/**
 * Cập nhật profile bot trong registry: tên, mô tả, role-access, và các trường UI mới
 * (dept, deptColor, role, tasks).
 * @param {string} id
 * @param {{ name?: string, description?: string, allowedRoleNames?: any, dept?: string, deptColor?: string, role?: string, tasks?: any }} fields
 */
async function updateBotProfile(id, fields) {
  const bot = registry.getBot(id);
  if (!bot) return { ok: false, message: 'Không tìm thấy bot' };
  const patch = {};
  if (fields.name !== undefined) {
    const n = String(fields.name || '').trim();
    if (!n || n.length > 255) return { ok: false, message: 'Tên bot không hợp lệ (1–255 ký tự)' };
    patch.name = n;
  }
  if (fields.description !== undefined) {
    patch.description = sanitizeBotDescription(fields.description);
  }
  if (fields.allowedRoleNames !== undefined) {
    const raw = fields.allowedRoleNames;
    const names = auth.normalizeRoleNames(raw);
    patch.allowedRoleNames = names;
  }
  if (fields.dept !== undefined) {
    const d = String(fields.dept || '').trim();
    if (d.length > 64) return { ok: false, message: 'Phòng ban tối đa 64 ký tự' };
    patch.dept = d;
  }
  if (fields.deptColor !== undefined) {
    const raw = String(fields.deptColor || '').trim();
    if (raw && !/^#[0-9a-fA-F]{6}$/.test(raw)) {
      return { ok: false, message: 'Màu phòng ban phải dạng hex #RRGGBB' };
    }
    patch.deptColor = raw;
  }
  if (fields.role !== undefined) {
    const r = String(fields.role || '').trim();
    if (r.length > 255) return { ok: false, message: 'Mô tả vai trò tối đa 255 ký tự' };
    patch.role = r;
  }
  if (fields.tasks !== undefined) {
    let arr = fields.tasks;
    if (typeof arr === 'string') {
      // Cho phép nhập 1 string với dòng/sep ; — split rồi trim
      arr = arr.split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(arr)) arr = [];
    arr = arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 10);
    if (arr.some((t) => t.length > 200)) {
      return { ok: false, message: 'Mỗi nhiệm vụ tối đa 200 ký tự' };
    }
    patch.tasks = arr;
  }
  if (!Object.keys(patch).length) {
    return { ok: false, message: 'Không có trường cập nhật' };
  }
  await registry.updateBot(id, patch);
  return { ok: true };
}

/**
 * Thư mục chứa index.html (UI tĩnh), không qua process Node bot — Platform đọc file trực tiếp.
 * Zip chuẩn: index.html cạnh server/.
 * @param {{ id: string, workDir?: string | null }} bot
 * @returns {string | null} đường dẫn tuyệt đối
 */
const ENV_VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function getBotServerEnvPaths(bot) {
  if (!bot || !bot.workDir) return { examplePath: null, envPath: null };
  const wd = path.resolve(bot.workDir);
  return {
    examplePath: path.join(wd, '.env.example'),
    envPath: path.join(wd, '.env'),
  };
}

/**
 * Parse .env.example → danh sách biến + gợi ý từ comment ngay phía trên.
 * @returns {{ key: string, exampleValue: string, hint: string }[]}
 */
function parseEnvExampleFile(content) {
  const lines = String(content || '').split(/\r?\n/);
  const out = [];
  let pendingHint = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('#')) {
      const c = trimmed.replace(/^#\s?/, '');
      pendingHint = pendingHint ? `${pendingHint} ${c}` : c;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!ENV_VAR_KEY_RE.test(key)) continue;
    let raw = line.slice(eq + 1).trim();
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      raw = raw.slice(1, -1);
    }
    out.push({ key, exampleValue: raw, hint: pendingHint });
    pendingHint = '';
  }
  return out;
}

/** PORT do Platform/PM2 gán — không đưa vào wizard và không ghi vào server/.env. */
function filterBotEnvTemplateEntries(entries) {
  return entries.filter((e) => String(e.key).toUpperCase() !== 'PORT');
}

function firstNonEmptyEnv(...vals) {
  for (const x of vals) {
    if (x == null) continue;
    const s = String(x).trim();
    if (s !== '') return s;
  }
  return undefined;
}

/**
 * Giá trị mặc định từ môi trường process của Platform (đã load dotenv / Docker env).
 * Ánh xạ tên biến bot ↔ platform khi khác tên (BASSO_URL / BASSO_BASE_URL, GitHub token).
 */
function platformDefaultForBotEnvKey(key) {
  const k = String(key);
  if (!k || k.toUpperCase() === 'PORT') return undefined;

  const direct = firstNonEmptyEnv(process.env[k]);
  if (direct !== undefined) return direct;

  if (k === 'BASSO_BASE_URL') {
    const u = firstNonEmptyEnv(process.env.BASSO_BASE_URL, process.env.BASSO_URL);
    return u ? u.replace(/\/+$/, '') : undefined;
  }
  if (k === 'BASSO_URL') {
    const u = firstNonEmptyEnv(process.env.BASSO_URL, process.env.BASSO_BASE_URL);
    return u ? u.replace(/\/+$/, '') : undefined;
  }
  if (k === 'GITHUB_TOKEN') {
    return firstNonEmptyEnv(process.env.GITHUB_TOKEN, process.env.GITHUB_CLONE_TOKEN);
  }

  return undefined;
}

function envValueLooksUnset(val) {
  const s = String(val || '').trim();
  if (!s) return true;
  const low = s.toLowerCase();
  if (low === 'your-basso-key-here') return true;
  if (low.includes('your-basso-key')) return true;
  if (/^sk-ant-api/.test(low) && low.endsWith('...')) return true;
  return false;
}

/** Ưu tiên: server/.env bot (nếu đã có giá trị) → Platform → mẫu .env.example */
function resolveBotEnvValueForKey(key, exampleValue, existingMap) {
  if (Object.prototype.hasOwnProperty.call(existingMap, key)) {
    const ex = existingMap[key];
    if (ex != null && String(ex).trim() !== '') return String(ex);
  }
  const plat = platformDefaultForBotEnvKey(key);
  if (plat !== undefined) return plat;
  return exampleValue != null ? String(exampleValue) : '';
}

function parseExistingEnvFile(content) {
  const lines = String(content || '').split(/\r?\n/);
  /** @type {Record<string, string>} */
  const map = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!ENV_VAR_KEY_RE.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
    map[key] = val;
  }
  return map;
}

function escapeEnvLineValue(val) {
  const s = String(val ?? '');
  if (/[\r\n"#]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/**
 * Mọi biến trong server/.env.example (trừ PORT) phải có giá trị hợp lệ (không trống / placeholder)
 * sau khi gộp server/.env + Platform + mẫu — nếu không thì không start PM2.
 */
function checkBotEnvReadyForStart(botId) {
  const bot = registry.getBot(botId);
  if (!bot || !bot.workDir || !fs.existsSync(bot.workDir)) {
    return { ok: false, message: 'Thiếu thư mục server (workDir)' };
  }
  const { examplePath, envPath } = getBotServerEnvPaths(bot);
  if (!fs.existsSync(examplePath)) {
    return { ok: true };
  }
  let templateVars;
  try {
    templateVars = filterBotEnvTemplateEntries(
      parseEnvExampleFile(fs.readFileSync(examplePath, 'utf8'))
    );
  } catch (e) {
    return { ok: false, message: `Đọc .env.example: ${e.message}` };
  }
  if (!templateVars.length) {
    return { ok: true };
  }
  let existing = {};
  if (fs.existsSync(envPath)) {
    try {
      existing = parseExistingEnvFile(fs.readFileSync(envPath, 'utf8'));
    } catch {
      /* */
    }
  }
  delete existing.PORT;
  const missing = [];
  for (const { key, exampleValue } of templateVars) {
    const val = resolveBotEnvValueForKey(key, exampleValue, existing);
    if (envValueLooksUnset(val)) missing.push(key);
  }
  if (missing.length) {
    return {
      ok: false,
      message: `Chưa đủ biến môi trường (theo server/.env.example): ${missing.join(', ')}. Điền server/.env hoặc wizard .env trên admin, rồi Restart.`,
    };
  }
  return { ok: true };
}

/**
 * Cho wizard .env: đọc server/.env.example + giá trị hiện tại server/.env (nếu có).
 */
function getBotEnvWizard(botId) {
  const bot = registry.getBot(botId);
  if (!bot) return { ok: false, message: 'Không tìm thấy bot' };
  if (!bot.workDir || !fs.existsSync(bot.workDir)) {
    return {
      ok: true,
      workDirReady: false,
      hasExample: false,
      variables: [],
      botStatus: bot.status || '',
    };
  }
  const { examplePath, envPath } = getBotServerEnvPaths(bot);
  if (!fs.existsSync(examplePath)) {
    return {
      ok: true,
      workDirReady: true,
      hasExample: false,
      variables: [],
      botStatus: bot.status || '',
      message: 'Không có file server/.env.example trong bot.',
    };
  }
  let templateVars;
  let rawTemplateCount = 0;
  try {
    const raw = parseEnvExampleFile(fs.readFileSync(examplePath, 'utf8'));
    rawTemplateCount = raw.length;
    templateVars = filterBotEnvTemplateEntries(raw);
  } catch (e) {
    return { ok: false, message: `Đọc .env.example: ${e.message}` };
  }
  if (!templateVars.length) {
    return {
      ok: true,
      workDirReady: true,
      hasExample: false,
      variables: [],
      botStatus: bot.status || '',
      message:
        rawTemplateCount > 0
          ? 'Trong .env.example chỉ có PORT (hoặc biến bị loại). PORT do platform/PM2 gán — không cần .env từ wizard, hoặc thêm biến khác vào .env.example.'
          : 'Không có biến nào trong server/.env.example.',
    };
  }
  let existing = {};
  if (envPath && fs.existsSync(envPath)) {
    try {
      existing = parseExistingEnvFile(fs.readFileSync(envPath, 'utf8'));
    } catch {
      /* */
    }
  }
  delete existing.PORT;
  const variables = templateVars.map((v) => {
    const currentValue = resolveBotEnvValueForKey(v.key, v.exampleValue, existing);
    return {
      key: v.key,
      hint: v.hint,
      exampleValue: v.exampleValue,
      currentValue,
      needsUserInput: envValueLooksUnset(currentValue),
      sensitive: /PASSWORD|SECRET|TOKEN|API_KEY|_KEY$/i.test(v.key),
    };
  });
  return {
    ok: true,
    workDirReady: true,
    hasExample: templateVars.length > 0,
    variables,
    envFile: 'server/.env',
    botStatus: bot.status || '',
  };
}

/**
 * Ghi server/.env chỉ với các key có trong .env.example (an toàn).
 * @param {string} botId
 * @param {Record<string, string>} valuesObj — có thể thiếu key → giữ từ .env cũ hoặc example
 */
function writeBotEnv(botId, valuesObj) {
  const bot = registry.getBot(botId);
  if (!bot || !bot.workDir || !fs.existsSync(bot.workDir)) {
    return { ok: false, message: 'Bot chưa có thư mục server (workDir)' };
  }
  const { examplePath, envPath } = getBotServerEnvPaths(bot);
  if (!fs.existsSync(examplePath)) {
    return { ok: false, message: 'Thiếu server/.env.example — không thể tạo .env an toàn' };
  }
  let templateVars;
  try {
    templateVars = filterBotEnvTemplateEntries(
      parseEnvExampleFile(fs.readFileSync(examplePath, 'utf8'))
    );
  } catch (e) {
    return { ok: false, message: `Đọc .env.example: ${e.message}` };
  }
  if (!templateVars.length) {
    return {
      ok: false,
      message:
        '.env.example không có biến nào (ngoài PORT). PORT do platform/PM2 gán — thêm biến khác vào .env.example hoặc sửa .env thủ công.',
    };
  }
  let existing = {};
  if (fs.existsSync(envPath)) {
    try {
      existing = parseExistingEnvFile(fs.readFileSync(envPath, 'utf8'));
    } catch {
      /* */
    }
  }
  delete existing.PORT;
  const input = valuesObj && typeof valuesObj === 'object' ? valuesObj : {};
  delete input.PORT;
  const lines = [
    '# Tạo / cập nhật từ Platform admin (theo server/.env.example). Sửa trực tiếp file này trên server khi cần.',
    '# Biến trùng tên với Platform (.env) được gán mặc định khi tạo/cập nhật (nếu bot chưa có giá trị).',
    '# PORT do platform/PM2 gán — không khai báo trong file này.',
    '',
  ];
  for (const { key, exampleValue } of templateVars) {
    let val;
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      val = input[key] == null ? '' : String(input[key]);
    } else {
      val = resolveBotEnvValueForKey(key, exampleValue, existing);
    }
    lines.push(`${key}=${escapeEnvLineValue(val)}`);
  }
  lines.push('');
  try {
    fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
  return { ok: true, path: envPath };
}

/** Lần đầu triển khai: tạo server/.env từ Platform + .env.example nếu chưa có file (trước pm2 start). */
async function seedInitialBotEnvFromPlatform(botId) {
  const bot = registry.getBot(botId);
  if (!bot || !bot.workDir || !fs.existsSync(bot.workDir)) return;
  const { examplePath, envPath } = getBotServerEnvPaths(bot);
  if (!fs.existsSync(examplePath) || fs.existsSync(envPath)) return;
  const w = writeBotEnv(botId, {});
  if (!w.ok) throw new Error(w.message || 'writeBotEnv');
}

function getBotUiRoot(bot) {
  if (!bot || !bot.id) return null;
  const extractRoot = path.join(BOTS_PARENT, bot.id);
  const wd = bot.workDir ? path.resolve(bot.workDir) : '';
  if (wd && fs.existsSync(wd)) {
    if (path.basename(wd) === 'server') {
      const parent = path.dirname(wd);
      const idx = path.join(parent, 'index.html');
      if (fs.existsSync(idx)) return parent;
    }
  }
  const top = path.join(extractRoot, 'index.html');
  if (fs.existsSync(top)) return extractRoot;
  try {
    const entries = fs.readdirSync(extractRoot, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    if (dirs.length === 1) {
      const sub = path.join(extractRoot, dirs[0].name);
      if (fs.existsSync(path.join(sub, 'index.html'))) return sub;
    }
  } catch {
    /* */
  }
  return null;
}

/** --- Watchdog: GET /health từng bot (localhost:port), tự restart khi chết / không phản hồi --- */
const healthFailStreak = new Map();
const lastHealthAutoRestartMs = new Map();
/** Map<botId, { ok: boolean, at: number }> — kết quả probe gần nhất, dùng cho dashboard online/offline. */
const lastHealthResult = new Map();
let healthWatchdogTimer = null;

/**
 * Trả về true nếu bot hiện đang ONLINE theo cảm nhận dashboard:
 *   - Status registry === 'running' (PM2 đang chạy), VÀ
 *   - (chưa có lần probe nào) HOẶC (probe gần nhất ok) HOẶC (probe gần nhất < 1 lần interval)
 *
 * Nói cách khác: bot mới start lên (chưa probe) coi như online; bot đã có probe ok gần đây coi là online;
 * bot probe fail nhưng còn trong cửa sổ retry trước khi restart cũng coi là online (tránh nhấp nháy UI).
 * @param {{ id: string, status?: string }} bot
 */
function isBotOnline(bot) {
  if (!bot) return false;
  // Admin đã tắt thủ công → luôn OFFLINE bất kể PM2 state
  if (bot.enabled === false) return false;
  if (bot.status !== 'running') return false;
  const last = lastHealthResult.get(bot.id);
  if (!last) return true;
  if (last.ok) return true;
  // Tolerate N-1 failed probes (sẽ restart sau N failures liên tiếp)
  const streak = healthFailStreak.get(bot.id) || 0;
  return streak < botHealthFailuresBeforeRestart();
}

function botHealthWatchdogEnabled() {
  const v = (process.env.PLATFORM_BOT_HEALTH_WATCHDOG || '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

function botHealthWatchdogIntervalMs() {
  const n = parseInt(process.env.PLATFORM_BOT_HEALTH_INTERVAL_MS || '45000', 10);
  return Math.min(600_000, Math.max(10_000, Number.isFinite(n) ? n : 45_000));
}

function botHealthProbeTimeoutMs() {
  const n = parseInt(process.env.PLATFORM_BOT_HEALTH_TIMEOUT_MS || '5000', 10);
  return Math.min(30_000, Math.max(2_000, Number.isFinite(n) ? n : 5000));
}

function botHealthPath() {
  const p = (process.env.PLATFORM_BOT_HEALTH_PATH || '/health').trim();
  return p.startsWith('/') ? p : `/${p}`;
}

function botHealthFailuresBeforeRestart() {
  const n = parseInt(process.env.PLATFORM_BOT_HEALTH_FAILURES || '2', 10);
  return Math.min(10, Math.max(1, Number.isFinite(n) ? n : 2));
}

function botHealthRestartCooldownMs() {
  const n = parseInt(process.env.PLATFORM_BOT_HEALTH_COOLDOWN_MS || '120000', 10);
  return Math.min(900_000, Math.max(30_000, Number.isFinite(n) ? n : 120_000));
}

async function probeBotHealthOnce(bot) {
  if (!bot.port) return { ok: false, error: 'no port' };
  try {
    const r = await requestLocal({
      port: bot.port,
      path: botHealthPath(),
      method: 'GET',
      headers: { Accept: '*/*' },
      timeoutMs: botHealthProbeTimeoutMs(),
    });
    const ok = r.statusCode >= 200 && r.statusCode < 300;
    return { ok, statusCode: r.statusCode };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function runBotHealthWatchdogTick() {
  if (!botHealthWatchdogEnabled()) return;
  const data = registry.readRegistry();
  // Bỏ qua bot admin đã tắt thủ công (enabled=false) — không auto-restart
  const bots = data.bots.filter((b) => b.enabled !== false && b.status === 'running' && b.port && b.workDir);
  const needFails = botHealthFailuresBeforeRestart();
  const cooldown = botHealthRestartCooldownMs();
  const now = Date.now();
  for (const bot of bots) {
    const id = bot.id;
    const probe = await probeBotHealthOnce(bot);
    lastHealthResult.set(id, { ok: probe.ok, at: Date.now() });
    if (probe.ok) {
      healthFailStreak.set(id, 0);
      continue;
    }
    const streak = (healthFailStreak.get(id) || 0) + 1;
    healthFailStreak.set(id, streak);
    if (streak < needFails) continue;

    const last = lastHealthAutoRestartMs.get(id) || 0;
    if (now - last < cooldown) continue;

    const detail =
      probe.statusCode != null ? `HTTP ${probe.statusCode}` : probe.error || 'unknown';
    console.warn(
      `[platform] Bot health: ${needFails} lỗi liên tiếp id=${id} port=${bot.port} ${botHealthPath()} (${detail}) → pm2 restart`
    );
    healthFailStreak.set(id, 0);
    lastHealthAutoRestartMs.set(id, now);
    const rr = await restartBot(id);
    if (!rr.ok) {
      console.warn(`[platform] Bot health auto-restart thất bại id=${id}:`, rr.message || '');
    }
  }
}

/**
 * Bật job định kỳ kiểm tra GET /health mỗi bot (127.0.0.1:port).
 * Tắt: PLATFORM_BOT_HEALTH_WATCHDOG=0
 */
function startBotHealthWatchdog() {
  if (!botHealthWatchdogEnabled()) {
    console.log('[platform] Bot health watchdog: tắt (PLATFORM_BOT_HEALTH_WATCHDOG=0)');
    return;
  }
  if (healthWatchdogTimer) return;
  const ms = botHealthWatchdogIntervalMs();
  const tick = () => {
    runBotHealthWatchdogTick().catch((e) => console.error('[platform] health watchdog:', e.message || e));
  };
  const firstDelay = Math.min(8000, ms);
  setTimeout(tick, firstDelay);
  healthWatchdogTimer = setInterval(tick, ms);
  if (typeof healthWatchdogTimer.unref === 'function') healthWatchdogTimer.unref();
  console.log(
    `[platform] Bot health watchdog: bật (mỗi ${ms}ms, GET ${botHealthPath()}, ${botHealthFailuresBeforeRestart()} lỗi liên tiếp → restart, cooldown ${botHealthRestartCooldownMs()}ms)`
  );
}

module.exports = {
  ensureDirs,
  enqueueProvision,
  enqueueProvisionFromGit,
  deleteBot,
  restartBot,
  setBotEnabled,
  reloadBot,
  updateBotProfile,
  getBotPm2Logs,
  getPlatformSystemLogs,
  getBotUiRoot,
  getBotEnvWizard,
  writeBotEnv,
  getBot: registry.getBot,
  readRegistry: registry.readRegistry,
  getBotPublicBase,
  getAuthProxyBot,
  getAuthProxyBotsOrdered,
  BOTS_PARENT,
  getBotIconPath,
  botHasIcon,
  getBotIconMimeForPath,
  saveBotIconFromUpload,
  startBotHealthWatchdog,
  isBotOnline,
  ensureGitDeployKey,
  getGitDeployPublicKey,
  listPythonBots,
  createPythonBot,
  reloadPythonBot,
  getPythonBotPm2Logs,
  deletePythonBot,
  getPythonBotEnvWizard,
  writePythonBotEnv,
};
