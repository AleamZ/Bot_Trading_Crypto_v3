// pm2 process for bot v3. Started by deploy.sh; by hand: pm2 start ecosystem.config.cjs --only bot-v3
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "bot-v3",
      cwd: __dirname,
      script: "apps/server/dist/src/main.js",
      // Node 22.13+ (node:sqlite). deploy.sh passes the node it checked, so a Node from nvm works
      // even when the system node (used by other apps) is older.
      interpreter: process.env.BOT_V3_NODE || "node",
      node_args: "--disable-warning=ExperimentalWarning",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5000,
      // SIGINT, then up to 20s to finish an entry in progress and flush Telegram.
      kill_timeout: 20000,
      time: true,
      out_file: path.join(__dirname, "logs/bot-v3/out.log"),
      error_file: path.join(__dirname, "logs/bot-v3/error.log"),
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
