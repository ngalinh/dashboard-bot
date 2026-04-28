#!/bin/sh
# Sinh lại toàn bộ PNG icon cho PWA + favicon từ 1 file logo nguồn.
#
# Yêu cầu: ImageMagick `convert` (hoặc `magick` trên IM7).
#   sudo apt-get install -y imagemagick
#
# Cách dùng (trên server, ở thư mục gốc repo):
#   sudo ./scripts/regen-pwa-icons.sh public/icons/source-logo.png
#
# Source logo nên là PNG vuông, ≥ 512×512 (1024×1024 là tốt nhất). Nếu logo
# đã có nền sẵn (vd. dark navy của Basso AI) thì script chỉ resize, không tô
# nền thêm — đảm bảo iOS Safari không hiển thị kèm 1 nền trắng phụ.
#
# Sau khi xong:
#   - public/icons/icon-48,72,96,192,512.png
#   - public/icons/apple-touch-icon-120,152,180.png
#   - public/icons/favicon-16,32.png
#
# Commit lại các file PNG mới + push lên git để CI auto-deploy.

set -eu

SRC="${1:-}"
if [ -z "$SRC" ]; then
  echo "Usage: sudo $0 <path-to-source-logo.png>" >&2
  exit 2
fi
if [ ! -f "$SRC" ]; then
  echo "Không thấy file: $SRC" >&2
  exit 1
fi

if command -v magick >/dev/null 2>&1; then
  CONVERT="magick"
elif command -v convert >/dev/null 2>&1; then
  CONVERT="convert"
else
  echo "Cần ImageMagick: sudo apt-get install -y imagemagick" >&2
  exit 1
fi

DEST_DIR="public/icons"
if [ ! -d "$DEST_DIR" ]; then
  echo "Không thấy $DEST_DIR — chạy script từ thư mục gốc repo." >&2
  exit 1
fi

echo "==> Source: $SRC ($($CONVERT identify -format '%wx%h' "$SRC" 2>/dev/null || echo '?'))"
echo "==> Output: $DEST_DIR"

resize() {
  size="$1"
  out="$2"
  $CONVERT "$SRC" -resize "${size}x${size}" -filter Lanczos "$out"
  echo "    $(basename "$out") (${size}x${size})"
}

resize 48  "$DEST_DIR/icon-48.png"
resize 72  "$DEST_DIR/icon-72.png"
resize 96  "$DEST_DIR/icon-96.png"
resize 192 "$DEST_DIR/icon-192.png"
resize 512 "$DEST_DIR/icon-512.png"

resize 120 "$DEST_DIR/apple-touch-icon-120.png"
resize 152 "$DEST_DIR/apple-touch-icon-152.png"
resize 180 "$DEST_DIR/apple-touch-icon-180.png"

resize 16  "$DEST_DIR/favicon-16.png"
resize 32  "$DEST_DIR/favicon-32.png"

echo
echo "✓ Done. Verify bằng: ls -la $DEST_DIR"
echo "  Sau đó commit + push để CI deploy:"
echo "    git add $DEST_DIR/*.png && git commit -m 'chore(icons): refresh PWA icons' && git push"
