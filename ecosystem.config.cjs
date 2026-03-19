/**
 * PM2 process configuration for OP-BET Keeper.
 *
 * VPS setup:
 *   npm install -g pm2
 *   cp .env.example .env && nano .env   # fill in MNEMONIC and DATABASE_URL
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup             # auto-restart on reboot
 */

module.exports = {
  apps: [
    {
      name: 'opbet-keeper',
      script: 'index.js',
      env_file: '.env',
      restart_delay: 5000,
      max_restarts: 20,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
