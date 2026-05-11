# Platform + PM2 (quản lý process bot). Build từ thư mục platform/.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates docker.io python3 python3-venv python3-pip openssh-client procps imagemagick tzdata \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pm2 \
  && git config --global --add safe.directory '*'

# PM2 --time prefix and bot Date() calls use this. tzdata provides the
# zoneinfo file libc tzset() reads when TZ is a region name.
ENV TZ=Asia/Ho_Chi_Minh

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

CMD ["node", "index.js"]
