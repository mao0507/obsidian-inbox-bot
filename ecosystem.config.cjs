// pm2 設定：由 pnpm run service:install 使用（見 scripts/service.js）。
module.exports = {
  apps: [
    {
      name: "obsidian-inbox-bot",
      script: "src/index.js",
      cwd: __dirname,
      autorestart: true,
      // 一啟動就掛（例如 .env 設定錯誤）時不要無限重啟洗 log：10 秒內掛掉算一次失敗，連續 10 次就停。
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 5000,
      time: true, // log 每行加時間戳
    },
  ],
};
