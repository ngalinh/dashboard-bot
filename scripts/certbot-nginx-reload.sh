#!/bin/sh
# Deploy hook cho Certbot: sau mỗi lần renew thành công, kiểm tra cấu hình và reload Nginx.
# Cài một lần (cần quyền root):
#   sudo install -m 755 scripts/certbot-nginx-reload.sh /etc/letsencrypt/renewal-hooks/deploy/50-reload-nginx.sh
#
set -e
if ! command -v nginx >/dev/null 2>&1; then
  exit 0
fi
nginx -t
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet nginx; then
  systemctl reload nginx
elif command -v service >/dev/null 2>&1; then
  service nginx reload || true
else
  nginx -s reload || true
fi
