/**
 * ID bot do platform sinh (hex). URL có thể gõ HOA — chuẩn hoá để khớp registry.
 * @param {unknown} id
 * @returns {string}
 */
function normalizeBotId(id) {
  if (id == null) return '';
  const s = String(id).trim();
  if (/^[a-fA-F0-9]+$/.test(s)) return s.toLowerCase();
  return s;
}

module.exports = { normalizeBotId };
