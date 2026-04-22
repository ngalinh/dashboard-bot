const fs = require('fs');
const path = require('path');
const { normalizeBotId } = require('./bot-id');

const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'bots-registry.json');

function defaultRegistry() {
  return { bots: [] };
}

function normalizeBot(b) {
  return {
    ...b,
    description: b.description == null ? '' : String(b.description),
    allowedRoleNames: Array.isArray(b.allowedRoleNames) ? b.allowedRoleNames.map((x) => String(x)) : [],
    dept: b.dept == null ? '' : String(b.dept),
    deptColor: b.deptColor == null ? '' : String(b.deptColor),
    role: b.role == null ? '' : String(b.role),
    tasks: Array.isArray(b.tasks) ? b.tasks.map((x) => String(x)) : [],
    enabled: b.enabled === false ? false : true,
  };
}

function readRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.bots)) data.bots = [];
    data.bots = data.bots.map(normalizeBot);
    return data;
  } catch {
    return defaultRegistry();
  }
}

function writeRegistry(data) {
  const dir = path.dirname(REGISTRY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${REGISTRY_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, REGISTRY_PATH);
}

async function updateBot(id, patch) {
  const nid = normalizeBotId(id);
  const data = readRegistry();
  const i = data.bots.findIndex((b) => b.id === nid);
  if (i === -1) return null;
  data.bots[i] = { ...data.bots[i], ...patch, updatedAt: new Date().toISOString() };
  writeRegistry(data);
  return data.bots[i];
}

async function addBot(bot) {
  const data = readRegistry();
  data.bots.push({
    ...bot,
    createdBotAt: bot.createdBotAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  writeRegistry(data);
  return bot;
}

async function removeBot(id) {
  const nid = normalizeBotId(id);
  const data = readRegistry();
  const before = data.bots.length;
  data.bots = data.bots.filter((b) => b.id !== nid);
  if (data.bots.length === before) return false;
  writeRegistry(data);
  return true;
}

function getBot(id) {
  const nid = normalizeBotId(id);
  if (!nid) return null;
  const b = readRegistry().bots.find((b) => b.id === nid);
  return b || null;
}

async function init() {
  const dir = path.dirname(REGISTRY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
