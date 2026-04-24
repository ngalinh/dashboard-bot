#!/usr/bin/env node
/**
 * Trích 7 avatar base64 trong preview/Dashboard.html thành file PNG dưới
 * assets/placeholder-avatars/. Chạy lại khi đổi design placeholder.
 *
 *   node scripts/extract-placeholder-avatars.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'preview', 'Dashboard.html');
const OUT_DIR = path.join(__dirname, '..', 'assets', 'placeholder-avatars');

const KEYS = ['mon', 'xeko', 'deki', 'mi', 'nobita', 'chaien', 'xuka'];

function extract(src) {
  const out = {};
  for (const k of KEYS) {
    const re = new RegExp(`${k}:\\s*'data:image/png;base64,([A-Za-z0-9+/=]+)'`);
    const m = re.exec(src);
    if (!m) throw new Error(`Không tìm thấy avatar cho key "${k}" trong ${SRC}`);
    out[k] = m[1];
  }
  return out;
}

function main() {
  const html = fs.readFileSync(SRC, 'utf8');
  const map = extract(html);
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [k, b64] of Object.entries(map)) {
    const file = path.join(OUT_DIR, `${k}.png`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log(`✓ ${path.relative(process.cwd(), file)} (${(b64.length * 0.75 / 1024).toFixed(1)} KB)`);
  }
}

main();
