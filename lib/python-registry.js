const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const PY_REGISTRY_PATH = path.join(__dirname, '..', 'data', 'python-bots-registry.json');

function envNonEmpty(key) {
  const v = process.env[key];
  return v != null && String(v).trim() !== '';
}

const useMysql =
  String(process.env.PLATFORM_REGISTRY || '').toLowerCase() === 'mysql' ||
  envNonEmpty('MYSQL_HOST') ||
  envNonEmpty('MYSQL_HOSTNAME') ||
  envNonEmpty('MYSQL_DATABASE') ||
  envNonEmpty('MYSQL_DB');

/** @type {import('mysql2/promise').Pool | null} */
let pool = null;
/** @type {Array<Object>} */
let cache = [];

function defaultRegistry() {
  return { bots: [] };
}

function readRegistryFs() {
  try {
    const raw = fs.readFileSync(PY_REGISTRY_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.bots)) data.bots = [];
    return data;
  } catch {
    return defaultRegistry();
  }
}

function writeRegistryFs(data) {
  const dir = path.dirname(PY_REGISTRY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${PY_REGISTRY_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, PY_REGISTRY_PATH);
}

function safeIdentifier(name) {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error('MYSQL_DATABASE chỉ được chữ, số và gạch dưới');
  }
  return name;
}

async function ensureSchemaMysql() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_python_bots (
      id VARCHAR(48) NOT NULL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      git_url TEXT NOT NULL,
      git_branch VARCHAR(255) NULL,
      entrypoint VARCHAR(255) NOT NULL DEFAULT 'bot.py',
      work_dir TEXT NULL,
      status VARCHAR(48) NOT NULL DEFAULT 'pending',
      status_message TEXT NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function rowToPyBot(row) {
  return {
    id: row.id,
    name: row.name,
    gitUrl: row.git_url,
    gitBranch: row.git_branch == null ? '' : String(row.git_branch),
    entrypoint: row.entrypoint || 'bot.py',
    workDir: row.work_dir == null ? null : row.work_dir,
    status: row.status,
    statusMessage: row.status_message == null ? '' : String(row.status_message),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at
          ? new Date(row.created_at).toISOString()
          : new Date().toISOString(),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at
          ? new Date(row.updated_at).toISOString()
          : new Date().toISOString(),
  };
}

async function loadCacheMysql() {
  if (!pool) return;
  const [rows] = await pool.query(
    'SELECT id, name, git_url, git_branch, entrypoint, work_dir, status, status_message, created_at, updated_at FROM platform_python_bots ORDER BY created_at ASC'
  );
  cache = Array.isArray(rows) ? rows.map((r) => rowToPyBot(r)) : [];
}

async function init() {
  if (!useMysql) {
    const dir = path.dirname(PY_REGISTRY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return;
  }
  const host = process.env.MYSQL_HOST || process.env.MYSQL_HOSTNAME || '127.0.0.1';
  const user = process.env.MYSQL_USER || process.env.MYSQL_USERNAME || 'root';
  const password = process.env.MYSQL_PASSWORD ?? '';
  const database = safeIdentifier(process.env.MYSQL_DATABASE || process.env.MYSQL_DB || 'basso_platform');
  const port = parseInt(process.env.MYSQL_PORT || '3306', 10);

  pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: Math.max(2, parseInt(process.env.MYSQL_CONNECTION_LIMIT || '10', 10)),
    enableKeepAlive: true,
  });

  await ensureSchemaMysql();
  await loadCacheMysql();
}

function list() {
  if (useMysql) return cache.map((b) => ({ ...b }));
  return readRegistryFs().bots.map((b) => ({ ...b }));
}

function get(id) {
  const sid = String(id || '').trim();
  if (!sid) return null;
  if (useMysql) return cache.find((b) => b.id === sid) || null;
  return readRegistryFs().bots.find((b) => b.id === sid) || null;
}

async function add(bot) {
  const b = {
    id: String(bot.id || ''),
    name: String(bot.name || ''),
    gitUrl: String(bot.gitUrl || ''),
    gitBranch: bot.gitBranch != null ? String(bot.gitBranch) : '',
    entrypoint: String(bot.entrypoint || 'bot.py'),
    workDir: bot.workDir != null ? String(bot.workDir) : null,
    status: String(bot.status || 'pending'),
    statusMessage: bot.statusMessage != null ? String(bot.statusMessage) : '',
    createdAt: bot.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (!b.id || !b.name || !b.gitUrl) throw new Error('Thiếu id/name/gitUrl');

  if (!useMysql) {
    const data = readRegistryFs();
    data.bots.push(b);
    writeRegistryFs(data);
    return b;
  }
  if (!pool) throw new Error('MySQL pool not initialized');
  const now = new Date();
  await pool.execute(
    `INSERT INTO platform_python_bots (id, name, git_url, git_branch, entrypoint, work_dir, status, status_message, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      b.id,
      b.name,
      b.gitUrl,
      b.gitBranch || null,
      b.entrypoint,
      b.workDir,
      b.status,
      b.statusMessage,
      new Date(b.createdAt),
      now,
    ]
  );
  const merged = { ...b, updatedAt: now.toISOString() };
  cache.push(merged);
  return merged;
}

async function update(id, patch) {
  const sid = String(id || '').trim();
  if (!sid) return null;
  if (!useMysql) {
    const data = readRegistryFs();
    const i = data.bots.findIndex((b) => b.id === sid);
    if (i === -1) return null;
    data.bots[i] = { ...data.bots[i], ...patch, updatedAt: new Date().toISOString() };
    writeRegistryFs(data);
    return data.bots[i];
  }
  if (!pool) throw new Error('MySQL pool not initialized');
  const idx = cache.findIndex((b) => b.id === sid);
  if (idx === -1) return null;
  const merged = { ...cache[idx], ...patch, updatedAt: new Date().toISOString() };
  await pool.execute(
    `UPDATE platform_python_bots
     SET name=?, git_url=?, git_branch=?, entrypoint=?, work_dir=?, status=?, status_message=?, updated_at=CURRENT_TIMESTAMP(3)
     WHERE id=?`,
    [
      merged.name,
      merged.gitUrl,
      merged.gitBranch || null,
      merged.entrypoint,
      merged.workDir,
      merged.status,
      merged.statusMessage || '',
      sid,
    ]
  );
  cache[idx] = merged;
  return merged;
}

async function remove(id) {
  const sid = String(id || '').trim();
  if (!sid) return false;
  if (!useMysql) {
    const data = readRegistryFs();
    const before = data.bots.length;
    data.bots = data.bots.filter((b) => b.id !== sid);
    if (data.bots.length === before) return false;
    writeRegistryFs(data);
    return true;
  }
  if (!pool) throw new Error('MySQL pool not initialized');
  const idx = cache.findIndex((b) => b.id === sid);
  if (idx === -1) return false;
  const [res] = await pool.execute('DELETE FROM platform_python_bots WHERE id=?', [sid]);
  if (!res || res.affectedRows === 0) return false;
  cache.splice(idx, 1);
  return true;
}

module.exports = {
  init,
  list,
  get,
  add,
  update,
  remove,
  useMysql,
  PY_REGISTRY_PATH,
};

