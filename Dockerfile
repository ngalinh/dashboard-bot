# Platform + PM2 (quản lý process bot). Build từ thư mục platform/.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates docker.io python3 python3-venv python3-pip openssh-client procps imagemagick \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pm2 \
  && git config --global --add safe.directory '*'

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Auto-sinh PWA icon (icon-48..512, apple-touch-icon-120..180, favicon-16/32)
# từ public/icons/source-logo.png nếu file đó tồn tại — user chỉ cần commit
# 1 file logo, build tự resize ra đủ 10 size.
RUN if [ -f public/icons/source-logo.png ]; then \
      sh scripts/regen-pwa-icons.sh public/icons/source-logo.png; \
    else \
      echo "(skip) public/icons/source-logo.png not found — using committed PNGs"; \
    fi

ENV NODE_ENV=production
EXPOSE 3980

# Chạy platform dưới pm2-runtime (PID 1) thay vì `node index.js` trực tiếp:
#   - autorestart + max_memory_restart (480M) định nghĩa trong ecosystem.config.cjs
#     cứu platform khi leak/OOM thay vì chỉ phụ thuộc Docker `restart: unless-stopped`.
#   - Cùng PM2 daemon quản lý các bot (pm2 start npm --name bot-{id}) — nhất quán.
# pm2-runtime giữ foreground (không daemonize) — phù hợp container.
CMD ["pm2-runtime", "start", "ecosystem.config.cjs", "--env", "production"]
