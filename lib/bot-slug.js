'use strict';

/**
 * Slug-based public URL cho mỗi bot.
 *
 * Cũ:  https://ai.basso.vn/b/<botId>/index.html
 * Mới: https://ai.basso.vn/<slug>/      (vd. /doraemon/)
 *
 * Slug được sinh từ bot.name (lowercase, bỏ dấu Việt, thay khoảng trắng/ký
 * tự lạ bằng `-`). Routing slug chỉ áp dụng khi:
 *   - Slug không trống.
 *   - Slug không nằm trong RESERVED_SLUGS (admin, platform, b, ...).
 *   - Đúng 1 bot có slug đó (deterministic theo id sort) — nếu trùng tên, bot
 *     có id nhỏ hơn theo lexical order "thắng", các bot khác fallback về
 *     /b/<id>/index.html.
 *
 * URL cũ /b/<id>/ vẫn được giữ chạy song song để tránh break link đã share.
 */

const RESERVED_SLUGS = new Set([
  // Top-level routes của Platform
  'admin',
  'platform',
  'b',
  'health',
  'api',
  // Static / file phổ biến của public/ và admin/
  'login',
  'login.html',
  'sw.js',
  'favicon.ico',
  'manifest.json',
  'robots.txt',
  'assets',
  'public',
  'static',
  // Đường dẫn nội bộ của repo (đề phòng nếu lộ ra qua mis-config)
  'data',
  'lib',
  'scripts',
  'node_modules',
  '.well-known',
]);

function stripDiacritics(input) {
  return String(input)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function slugify(name) {
  if (!name || typeof name !== 'string') return '';
  return stripDiacritics(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function isReservedSlug(slug) {
  if (!slug) return true;
  return RESERVED_SLUGS.has(String(slug).toLowerCase());
}

/**
 * Tìm bot theo slug. Khi nhiều bot có cùng slug, chọn bot có id nhỏ nhất theo
 * lexical sort để output stable (vẫn truy cập được các bot còn lại qua /b/<id>/).
 */
function getBotBySlug(slug, allBots) {
  if (!slug || isReservedSlug(slug) || !Array.isArray(allBots) || !allBots.length) return null;
  const target = String(slug).toLowerCase();
  let winner = null;
  for (const bot of allBots) {
    if (!bot || !bot.id || !bot.name) continue;
    if (slugify(bot.name) !== target) continue;
    if (!winner || String(bot.id) < String(winner.id)) winner = bot;
  }
  return winner;
}

/**
 * Slug "canonical" của 1 bot (slug mà /(slug)/ thật sự sẽ resolve về bot này).
 * Trả null khi: tên rỗng, slug trùng reserved, hoặc bot khác có slug giống và id nhỏ hơn.
 */
function getCanonicalSlug(bot, allBots) {
  if (!bot || !bot.id || !bot.name) return null;
  const s = slugify(bot.name);
  if (!s || isReservedSlug(s)) return null;
  const winner = getBotBySlug(s, allBots);
  if (winner && String(winner.id) === String(bot.id)) return s;
  return null;
}

/**
 * URL public của bot: ưu tiên /<slug>/, fallback /b/<id>/index.html.
 */
function buildChatUrl(base, bot, allBots) {
  if (!bot || !bot.id) return null;
  const baseTrim = (base || '').replace(/\/+$/, '');
  const slug = getCanonicalSlug(bot, allBots);
  if (slug) return `${baseTrim}/${slug}/`;
  return `${baseTrim}/b/${bot.id}/index.html`;
}

module.exports = {
  RESERVED_SLUGS,
  slugify,
  isReservedSlug,
  getBotBySlug,
  getCanonicalSlug,
  buildChatUrl,
};
