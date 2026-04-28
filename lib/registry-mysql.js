const mysql = require('mysql2/promise');
const { normalizeBotId } = require('./bot-id');

const REGISTRY_PATH = null;

/** @type {import('mysql2/promise').Pool | null} */
let pool = null;
/** @type {Array<Object>} */
let botsCache = [];

function rowToBot(row) {
  let tasks = [];
  if (row.tasks != null) {
    if (Array.isArray(row.tasks)) tasks = row.tasks.map((x) => String(x));
    else if (typeof row.tasks === 'string') {
      try {
        const parsed = JSON.parse(row.tasks);
        if (Array.isArray(parsed)) tasks = parsed.map((x) => String(x));
      } catch { /* ignore */ }
    }
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description == null ? '' : String(row.description),
    allowedRoleNames:
      row.allowed_role_names == null
        ? []
        : Array.isArray(row.allowed_role_names)
          ? row.allowed_role_names.map((x) => String(x))
          : [],
    dept: row.dept == null ? '' : String(row.dept),
    deptColor: row.dept_color == null ? '' : String(row.dept_color),
    role: row.role == null ? '' : String(row.role),
    tasks,
    enabled: row.enabled == null ? true : Boolean(Number(row.enabled)),
    status: row.status,
    port: row.port == null ? null : Number(row.port),
    workDir: row.work_dir == null ? null : row.work_dir,
    statusMessage: row.status_message == null ? '' : String(row.status_message),
    gitUrl: row.git_url == null ? '' : String(row.git_url),
    gitBranch: row.git_branch == null ? '' : String(row.git_branch),
    createdBotAt:
      row.created_bot_at instanceof Date
        ? row.created_bot_at.toISOString()
        : row.created_bot_at
          ? new Date(row.created_bot_at).toISOString()
          : undefined,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at
          ? new Date(row.updated_at).toISOString()
          : new Date().toISOString(),
  };
}

function readRegistry() {
  return { bots: botsCache.map((b) => ({ ...b })) };
}

function getBot(id) {
  const nid = normalizeBotId(id);
  if (!nid) return null;
  return botsCache.find((b) => b.id === nid) || null;
}

async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_bots (
      id VARCHAR(32) NOT NULL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT NULL,
      allowed_role_names JSON NULL,
      status VARCHAR(48) NOT NULL DEFAULT 'pending',
      port INT NULL,
      work_dir TEXT NULL,
      status_message TEXT NULL,
      created_bot_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      INDEX idx_platform_bots_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_bots' AND COLUMN_NAME = 'description'`
  );
  if (!Array.isArray(cols) || cols.length === 0) {
    await pool.query('ALTER TABLE platform_bots ADD COLUMN description TEXT NULL AFTER name');
  }
  const [cols2] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_bots' AND COLUMN_NAME = 'allowed_role_names'`
  );
  if (!Array.isArray(cols2) || cols2.length === 0) {
    await pool.query('ALTER TABLE platform_bots ADD COLUMN allowed_role_names JSON NULL AFTER description');
  }

  // Migration: add dept / dept_color / role / tasks / enabled columns for the new dashboard UI
  const [cols3] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_bots'
       AND COLUMN_NAME IN ('dept','dept_color','role','tasks','enabled')`
  );
  const have = new Set((Array.isArray(cols3) ? cols3 : []).map((r) => String(r.COLUMN_NAME)));
  if (!have.has('dept')) {
    await pool.query('ALTER TABLE platform_bots ADD COLUMN dept VARCHAR(64) NULL AFTER allowed_role_names');
  }
  if (!have.has('dept_color')) {
    await pool.query('ALTER TABLE platform_bots ADD COLUMN dept_color VARCHAR(16) NULL AFTER dept');
  }
  if (!have.has('role')) {
    await pool.query('ALTER TABLE platform_bots ADD COLUMN role TEXT NULL AFTER dept_color');
  }
  if (!have.has('tasks')) {
    await pool.query('ALTER TABLE platform_bots ADD COLUMN tasks JSON NULL AFTER role');
  }
  if (!have.has('enabled')) {
    await pool.query('ALTER TABLE platform_bots ADD COLUMN enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER tasks');
  }

  // Migration: add git_url / git_branch columns for bots cloned from GitHub.
  const [cols4] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_bots'
       AND COLUMN_NAME IN ('git_url','git_branch')`
  );
  const haveGit = new Set((Array.isArray(cols4) ? cols4 : []).map((r) => String(r.COLUMN_NAME)));
  if (!haveGit.has('git_url')) {
    await pool.query('ALTER TABLE platform_bots ADD COLUMN git_url VARCHAR(512) NULL AFTER status_message');
  }
  if (!haveGit.has('git_branch')) {
    await pool.query('ALTER TABLE platform_bots ADD COLUMN git_branch VARCHAR(255) NULL AFTER git_url');
  }
}

async function loadCache() {
  if (!pool) return;
  const [rows] = await pool.query(
    'SELECT id, name, description, allowed_role_names, dept, dept_color, role, tasks, enabled, status, port, work_dir, status_message, git_url, git_branch, created_bot_at, updated_at FROM platform_bots ORDER BY created_bot_at ASC'
  );
  botsCache = rows.map((r) => rowToBot(r));
}

function safeIdentifier(name) {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error('MYSQL_DATABASE chỉ được chữ, số và gạch dưới');
  }
  return name;
}

async function init() {
  const host = process.env.MYSQL_HOST || process.env.MYSQL_HOSTNAME || '127.0.0.1';
  const user = process.env.MYSQL_USER || process.env.MYSQL_USERNAME || 'root';
  const password = process.env.MYSQL_PASSWORD ?? '';
  const database = safeIdentifier(process.env.MYSQL_DATABASE || process.env.MYSQL_DB || 'basso_platform');
  const port = parseInt(process.env.MYSQL_PORT || '3306', 10);

  const bootstrap = await mysql.createConnection({ host, port, user, password });
  await bootstrap.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await bootstrap.end();

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

  await ensureSchema();
  await loadCache();
  console.log('[platform] MySQL registry:', database, '@', host, `(${botsCache.length} bot)`);
}

async function addBot(bot) {
  if (!pool) throw new Error('MySQL pool not initialized');
  const now = new Date();
  const createdBotAt = bot.createdBotAt ? new Date(bot.createdBotAt) : now;
  const desc = bot.description != null ? String(bot.description) : '';
  const roles = Array.isArray(bot.allowedRoleNames) ? bot.allowedRoleNames.map((x) => String(x)) : [];
  const dept = bot.dept != null ? String(bot.dept) : '';
  const deptColor = bot.deptColor != null ? String(bot.deptColor) : '';
  const role = bot.role != null ? String(bot.role) : '';
  const tasks = Array.isArray(bot.tasks) ? bot.tasks.map((x) => String(x)) : [];
  const enabled = bot.enabled === false ? 0 : 1;
  const gitUrl = bot.gitUrl != null ? String(bot.gitUrl) : '';
  const gitBranch = bot.gitBranch != null ? String(bot.gitBranch) : '';
  await pool.execute(
    `INSERT INTO platform_bots (id, name, description, allowed_role_names, dept, dept_color, role, tasks, enabled, status, port, work_dir, status_message, git_url, git_branch, created_bot_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      bot.id,
      bot.name,
      desc,
      roles.length ? JSON.stringify(roles) : null,
      dept || null,
      deptColor || null,
      role || null,
      tasks.length ? JSON.stringify(tasks) : null,
      enabled,
      bot.status || 'pending',
      bot.port ?? null,
      bot.workDir ?? null,
      bot.statusMessage ?? '',
      gitUrl || null,
      gitBranch || null,
      createdBotAt,
      now,
    ]
  );
  const b = {
    id: bot.id,
    name: bot.name,
    description: desc,
    allowedRoleNames: roles,
    dept,
    deptColor,
    role,
    tasks,
    enabled: enabled === 1,
    status: bot.status || 'pending',
    port: bot.port ?? null,
    workDir: bot.workDir ?? null,
    statusMessage: bot.statusMessage ?? '',
    gitUrl,
    gitBranch,
    createdBotAt: createdBotAt.toISOString(),
    updatedAt: now.toISOString(),
  };
  botsCache.push(b);
  return bot;
}

async function updateBot(id, patch) {
  if (!pool) throw new Error('MySQL pool not initialized');
  const nid = normalizeBotId(id);
  const idx = botsCache.findIndex((x) => x.id === nid);
  if (idx === -1) return null;
  const merged = { ...botsCache[idx], ...patch };
  merged.updatedAt = new Date().toISOString();
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  const desc = has('description')
    ? patch.description == null ? '' : String(patch.description)
    : String(botsCache[idx].description ?? '');
  const roles = has('allowedRoleNames')
    ? (Array.isArray(patch.allowedRoleNames) ? patch.allowedRoleNames.map((x) => String(x)) : [])
    : (Array.isArray(botsCache[idx].allowedRoleNames) ? botsCache[idx].allowedRoleNames.map((x) => String(x)) : []);
  const dept = has('dept')
    ? (patch.dept == null ? '' : String(patch.dept))
    : String(botsCache[idx].dept ?? '');
  const deptColor = has('deptColor')
    ? (patch.deptColor == null ? '' : String(patch.deptColor))
    : String(botsCache[idx].deptColor ?? '');
  const role = has('role')
    ? (patch.role == null ? '' : String(patch.role))
    : String(botsCache[idx].role ?? '');
  const tasks = has('tasks')
    ? (Array.isArray(patch.tasks) ? patch.tasks.map((x) => String(x)) : [])
    : (Array.isArray(botsCache[idx].tasks) ? botsCache[idx].tasks.map((x) => String(x)) : []);
  const enabled = has('enabled')
    ? (patch.enabled === false ? 0 : 1)
    : (botsCache[idx].enabled === false ? 0 : 1);
  const gitUrl = has('gitUrl')
    ? (patch.gitUrl == null ? '' : String(patch.gitUrl))
    : String(botsCache[idx].gitUrl ?? '');
  const gitBranch = has('gitBranch')
    ? (patch.gitBranch == null ? '' : String(patch.gitBranch))
    : String(botsCache[idx].gitBranch ?? '');
  await pool.execute(
    `UPDATE platform_bots SET name=?, description=?, allowed_role_names=?, dept=?, dept_color=?, role=?, tasks=?, enabled=?, status=?, port=?, work_dir=?, status_message=?, git_url=?, git_branch=?, updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
    [
      merged.name,
      desc,
      roles.length ? JSON.stringify(roles) : null,
      dept || null,
      deptColor || null,
      role || null,
      tasks.length ? JSON.stringify(tasks) : null,
      enabled,
      merged.status,
      merged.port ?? null,
      merged.workDir ?? null,
      merged.statusMessage ?? '',
      gitUrl || null,
      gitBranch || null,
      nid,
    ]
  );
  merged.description = desc;
  merged.allowedRoleNames = roles;
  merged.dept = dept;
  merged.deptColor = deptColor;
  merged.role = role;
  merged.tasks = tasks;
  merged.enabled = enabled === 1;
  merged.gitUrl = gitUrl;
  merged.gitBranch = gitBranch;
  botsCache[idx] = merged;
  return merged;
}


/**
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function removeBot(id) {
  if (!pool) throw new Error('MySQL pool not initialized');
  const nid = normalizeBotId(id);
  const idx = botsCache.findIndex((x) => x.id === nid);
  if (idx === -1) return false;
  const [res] = await pool.execute('DELETE FROM platform_bots WHERE id=?', [nid]);
  if (!res || res.affectedRows === 0) return false;
  botsCache.splice(idx, 1);
  return true;
}

module.exports = {
  init,
  readRegistry,
  getBot,
  addBot,
  updateBot,
  removeBot,
  REGISTRY_PATH,
};
