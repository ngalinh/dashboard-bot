#!/bin/sh
# Phục hồi 1 số bảng từ file backup tar.gz (do scripts/recover-mysql.sh tạo).
#
# Cơ chế: dựng MySQL phụ trên port 3307 từ data dir trong backup, mysqldump
# các bảng cần khôi phục, rồi import vào MySQL chính. Bot/Platform tiếp tục
# chạy bình thường trừ lúc bước stop bot để import.
#
# Cách dùng (chạy ở thư mục gốc repo, có docker-compose.prod.yml):
#   sudo ./scripts/restore-tables-from-backup.sh \
#        ~/mysql-backup-2026-04-28-0839.tar.gz \
#        basso_platform \
#        user_sessions daily_order_stats app_config \
#        --bot=bot-794e5c0b078fc669
#
# Tham số:
#   $1                BACKUP_TAR_GZ — file tar.gz (chứa thư mục mysql/)
#   $2                DATABASE      — schema name trong backup
#   $3..$N            TABLES        — danh sách bảng cần restore (cách nhau khoảng trắng)
#   --bot=<pm2-name>  (tuỳ chọn)    — pm2 process name của bot dùng các bảng đó.
#                                      Sẽ được stop trong lúc import + restart sau.
#   --keep-temp       (tuỳ chọn)    — không xoá MySQL phụ + thư mục tạm sau khi xong.
#
# Lưu ý: lệnh sẽ DROP các bảng đó trong MySQL chính trước khi import — mọi
# data ghi vào các bảng này từ sau backup sẽ MẤT. Cân nhắc trước khi chạy.

set -eu

COMPOSE_FILE="docker-compose.prod.yml"
TEMP_RESTORE_DIR="/tmp/mysql-restore-$(date +%s)"
TEMP_DUMP_FILE="/tmp/restore-tables-$(date +%s).sql"
TEMP_CONTAINER="mysql-restore-$(date +%s)"
KEEP_TEMP=0
BOT_PM2_NAME=""
POSITIONAL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --bot=*) BOT_PM2_NAME="${1#--bot=}"; shift ;;
    --keep-temp) KEEP_TEMP=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    --*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *) POSITIONAL="$POSITIONAL '$1'"; shift ;;
  esac
done
eval set -- $POSITIONAL

if [ "$#" -lt 3 ]; then
  echo "Usage: sudo $0 <backup.tar.gz> <database> <table> [<table> ...] [--bot=<pm2-name>] [--keep-temp]" >&2
  exit 2
fi

BACKUP_TAR="$1"; shift
DATABASE="$1"; shift
TABLES="$*"

if [ "$(id -u)" -ne 0 ]; then
  echo "Cần quyền root (chown trên restore dir + docker)." >&2
  exit 1
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Không thấy $COMPOSE_FILE — chạy script từ thư mục gốc repo." >&2
  exit 1
fi
if [ ! -f "$BACKUP_TAR" ]; then
  echo "Không thấy file backup: $BACKUP_TAR" >&2
  exit 1
fi
if [ ! -f .env ]; then
  echo "Không thấy .env — cần MYSQL_ROOT_PASSWORD." >&2
  exit 1
fi

ROOT_PW="$(grep -E '^MYSQL_ROOT_PASSWORD=' .env | head -1 | cut -d= -f2-)"
if [ -z "$ROOT_PW" ]; then
  echo "MYSQL_ROOT_PASSWORD trong .env trống." >&2
  exit 1
fi

cleanup() {
  if [ "$KEEP_TEMP" -eq 0 ]; then
    echo "==> Cleanup MySQL phụ + temp files"
    docker rm -f "$TEMP_CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$TEMP_RESTORE_DIR" "$TEMP_DUMP_FILE"
  else
    echo "==> --keep-temp: giữ lại $TEMP_RESTORE_DIR + container $TEMP_CONTAINER"
  fi
}
trap cleanup EXIT

echo "==> 1. Giải nén backup -> $TEMP_RESTORE_DIR"
mkdir -p "$TEMP_RESTORE_DIR"
tar -xzf "$BACKUP_TAR" -C "$TEMP_RESTORE_DIR"
if [ ! -d "$TEMP_RESTORE_DIR/mysql/$DATABASE" ]; then
  echo "Không thấy thư mục $TEMP_RESTORE_DIR/mysql/$DATABASE trong backup." >&2
  exit 1
fi
chown -R 999:999 "$TEMP_RESTORE_DIR/mysql"

echo "==> 2. Chạy MySQL phụ ($TEMP_CONTAINER) đọc backup"
docker run -d --name "$TEMP_CONTAINER" \
  -e MYSQL_ROOT_PASSWORD="$ROOT_PW" \
  -v "$TEMP_RESTORE_DIR/mysql:/var/lib/mysql" \
  mysql:8.4 >/dev/null

echo "==> 3. Đợi MySQL phụ healthy (tối đa 90s)"
i=0
until docker exec "$TEMP_CONTAINER" mysqladmin -uroot -p"$ROOT_PW" ping >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "MySQL phụ không lên — kiểm tra: docker logs $TEMP_CONTAINER" >&2
    docker logs --tail=40 "$TEMP_CONTAINER" >&2
    exit 1
  fi
  sleep 3
done

echo "==> 4. Dump các bảng từ MySQL phụ -> $TEMP_DUMP_FILE"
# shellcheck disable=SC2086
docker exec "$TEMP_CONTAINER" mysqldump \
  -uroot -p"$ROOT_PW" \
  --no-tablespaces --skip-add-locks --skip-lock-tables \
  "$DATABASE" $TABLES > "$TEMP_DUMP_FILE"
ls -lh "$TEMP_DUMP_FILE"

if [ -n "$BOT_PM2_NAME" ]; then
  echo "==> 5. Stop bot $BOT_PM2_NAME để tránh ghi đè khi import"
  docker compose -f "$COMPOSE_FILE" exec -T platform pm2 stop "$BOT_PM2_NAME" || true
fi

echo "==> 6. DROP các bảng cũ trên MySQL chính"
DROP_SQL=""
for t in $TABLES; do
  DROP_SQL="$DROP_SQL DROP TABLE IF EXISTS \`$t\`;"
done
docker compose -f "$COMPOSE_FILE" exec -T mysql sh -c "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" $DATABASE" <<EOF
$DROP_SQL
EOF

echo "==> 7. Import dump vào MySQL chính"
docker compose -f "$COMPOSE_FILE" exec -T mysql sh -c "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" $DATABASE" < "$TEMP_DUMP_FILE"

echo "==> 8. Verify số dòng"
SELECT_SQL=""
for t in $TABLES; do
  SELECT_SQL="$SELECT_SQL SELECT '$t' AS table_name, COUNT(*) AS rows FROM \`$t\`;"
done
docker compose -f "$COMPOSE_FILE" exec -T mysql sh -c "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" $DATABASE -e \"$SELECT_SQL\""

if [ -n "$BOT_PM2_NAME" ]; then
  echo "==> 9. Restart bot $BOT_PM2_NAME"
  docker compose -f "$COMPOSE_FILE" exec -T platform pm2 restart "$BOT_PM2_NAME" || true
fi

echo
echo "✓ Done. Mở lại bot kiểm tra lịch sử chat."
