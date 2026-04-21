/**
 * PM2 — chạy Platform trên VPS.
 *   cd platform && pm2 start ecosystem.config.cjs --env production
 *
 * Gợi ý VPS 4 vCPU / 8 GB RAM:
 * - Platform 1 process (fork) — đủ; cluster nhiều instance ít lợi vì proxy + registry.
 * - Để ~5–6 GB cho bot + OS: đặt trong .env BOT_NODE_OPTIONS + BOT_PM2_MAX_MEMORY (xem .env.example).
 * - Nginx: worker_processes auto trong nginx.conf thường = số core (4).
 */
module.exports = {
  apps: [
    {
      name: 'basso-bot-platform',
      cwd: __dirname,
      script: 'index.js',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      /** Heap V8 ~384M; PM2 restart nếu leak vượt ~450M */
      node_args: '--max-old-space-size=384',
      max_memory_restart: '480M',
      env: {
        NODE_ENV: 'development',
        PORT: 3980,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3980,
      },
    },
  ],
};
