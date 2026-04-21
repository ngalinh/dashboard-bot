# Platform + PM2 (quản lý process bot). Build từ thư mục platform/.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates docker.io python3 python3-venv python3-pip openssh-client procps \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pm2 \
  && git config --global --add safe.directory '*'

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3980

CMD ["node", "index.js"]
