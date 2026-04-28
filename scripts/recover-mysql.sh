#!/bin/sh
# Khôi phục MySQL container khi crash với lỗi:
#   [ERROR] [MY-012595] [InnoDB] The error means mysqld does not have the access rights to the directory.
#   [ERROR] [MY-012592] [InnoDB] Operating system error number 13 in a file operation.
#   [ERROR] [MY-012894] [InnoDB] Unable to open './#innodb_redo/#ib_redoN' (error: 1000).
#
# Nguyên nhân thường gặp: thư mục data/mysql trên host bị sai owner, không khớp UID/GID
# 999:999 mà image mysql:8.4 dùng cho user `mysql` bên trong container — có thể do
# chown nhầm, restore từ backup khác user, hoặc dùng userns-remap rồi tắt đi.
#
# Cách dùng (chạy ở thư mục gốc repo, có file docker-compose.prod.yml):
#   sudo ./scripts/recover-mysql.sh                 # chỉ chown + restart
#   sudo ./scripts/recover-mysql.sh --reset-redo    # chown + nuke redo log nếu chown không đủ
#
# Lưu ý: script LUÔN tar.gz backup data/mysql trước khi --reset-redo.

set -eu

COMPOSE_FILE="docker-compose.prod.yml"
DATA_DIR="./data/mysql"
MYSQL_UID=999
MYSQL_GID=999
RESET_REDO=0

for arg in "$@"; do
  case "$arg" in
    --reset-redo) RESET_REDO=1 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0 ;;
    *)
      echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Không thấy $COMPOSE_FILE — chạy script từ thư mục gốc repo." >&2
  exit 1
fi

if [ ! -d "$DATA_DIR" ]; then
  echo "Không thấy $DATA_DIR — chưa từng start MySQL ở repo này?" >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Cần quyền root (chown trên data dir). Chạy: sudo $0 $*" >&2
  exit 1
fi

echo "==> Stop mysql container"
docker compose -f "$COMPOSE_FILE" stop mysql || true

echo "==> Chown $DATA_DIR -> $MYSQL_UID:$MYSQL_GID"
chown -R "$MYSQL_UID:$MYSQL_GID" "$DATA_DIR"

if [ "$RESET_REDO" -eq 1 ]; then
  BACKUP="$HOME/mysql-backup-$(date +%F-%H%M).tar.gz"
  echo "==> Backup -> $BACKUP"
  tar -czf "$BACKUP" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"

  REDO_DIR="$DATA_DIR/#innodb_redo"
  QUARANTINE="./data/mysql_redo_quarantine_$(date +%F-%H%M)"
  if [ -d "$REDO_DIR" ] && [ -n "$(ls -A "$REDO_DIR" 2>/dev/null)" ]; then
    echo "==> Move redo logs -> $QUARANTINE (sẽ tự tạo lại khi MySQL start)"
    mkdir -p "$QUARANTINE"
    # dùng sh -c để root expand glob (#innodb_redo dir thường chmod 750)
    sh -c "mv $REDO_DIR/* $QUARANTINE/"
  fi
fi

echo "==> Start mysql container"
docker compose -f "$COMPOSE_FILE" start mysql

echo "==> Đợi 25s rồi xem log gần nhất"
sleep 25
docker compose -f "$COMPOSE_FILE" logs --tail=40 mysql || true
echo
docker compose -f "$COMPOSE_FILE" ps

cat <<'EOF'

Kỳ vọng:
  - Trong log có dòng "ready for connections. Version: '8.4...'"
  - `ps` cột STATUS của mysql là "Up ... (healthy)"
Nếu vẫn lặp [MY-012595] mỗi giây → chạy lại với --reset-redo.
EOF
