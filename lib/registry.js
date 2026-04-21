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

const impl = useMysql ? require('./registry-mysql') : require('./registry-fs');

if (useMysql) {
  console.log('[platform] Registry backend: MySQL');
} else {
  console.log('[platform] Registry backend: file (data/bots-registry.json)');
}

module.exports = impl;
