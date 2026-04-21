#!/usr/bin/env node
/**
 * Tự sinh cấu hình Nginx site từ .env (không reload Nginx — bạn tự nginx -t && reload).
 *
 * ENV:
 *   NGINX_DOMAIN          — server_name (production: ai.basso.vn)
 *   NGINX_PLATFORM_PORT   — mặc định = PORT hoặc 3980
 *   NGINX_SSL_CERT        — đường dẫn fullchain.pem
 *   NGINX_SSL_KEY         — đường dẫn privkey.pem
 *
 * Chạy từ thư mục platform:
 *   node scripts/generate-nginx-site.cjs
 *   node scripts/generate-nginx-site.cjs --out data/generated/nginx-site.conf
 *   node scripts/generate-nginx-site.cjs --http-only --out data/generated/nginx-site.conf
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const argv = process.argv.slice(2);
let outPath = null;
let httpOnly = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out' && argv[i + 1]) {
    outPath = path.resolve(argv[++i]);
  } else if (argv[i] === '--http-only') {
    httpOnly = true;
  }
}

const domain =
  process.env.NGINX_DOMAIN ||
  process.env.PUBLIC_ORIGIN?.replace(/^https?:\/\//, '').replace(/\/$/, '') ||
  'ai.basso.vn';
if (!process.env.NGINX_DOMAIN && !process.env.PUBLIC_ORIGIN) {
  console.warn('[gen:nginx] Dùng mặc định server_name:', domain, '(đặt NGINX_DOMAIN hoặc PUBLIC_ORIGIN trong .env)');
}

const platformPort = process.env.NGINX_PLATFORM_PORT || process.env.PORT || '3980';
const cert = process.env.NGINX_SSL_CERT || '/etc/letsencrypt/live/' + domain + '/fullchain.pem';
const key = process.env.NGINX_SSL_KEY || '/etc/letsencrypt/live/' + domain + '/privkey.pem';

const tplName = httpOnly ? 'site.http-only.template.conf' : 'site.template.conf';
const tplPath = path.join(__dirname, '..', 'nginx', tplName);
let text = fs.readFileSync(tplPath, 'utf8');
text = text.replace(/__DOMAIN__/g, domain).replace(/__PLATFORM_PORT__/g, String(platformPort));
if (!httpOnly) {
  text = text.replace(/__CERT_PATH__/g, cert).replace(/__KEY_PATH__/g, key);
}

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text, 'utf8');
  console.log('Đã ghi:', outPath);
  console.log('Tiếp theo: sudo nginx -t && sudo install/copy file vào sites-available và reload.');
} else {
  process.stdout.write(text);
}
