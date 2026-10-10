/**
 * PM2 process definition for THE TEAM API.
 *
 * Start it with:
 *   pm2 start ecosystem.config.js
 *
 * NODE_ENV has to be set HERE, not inside .env.production. config/env.js needs to
 * know it is in production before it can decide which env file to read, and a value
 * inside a file cannot influence the choice of that same file.
 *
 * After changing this:  pm2 restart ecosystem.config.js --update-env
 */

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'theteam-api',
      script: path.resolve(__dirname, 'server.js'),
      cwd: __dirname,

      env: {
        NODE_ENV: 'production',
        PORT: 5000,
        // Stamp the commit being deployed so reports can be tied to a build.
        // Override in the shell: BUILD_ID=$(git rev-parse --short HEAD) pm2 restart
        BUILD_ID: process.env.BUILD_ID || ''
      },

      // A crashed API should come back without anyone noticing.
      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',

      // Stay well under a 2 GB server. Recycle before the OOM killer does it.
      max_memory_restart: '400M',

      // Logs live outside the project so backups and rebuilds do not touch them.
      error_file: path.resolve(__dirname, '..', 'logs', 'err.log'),
      out_file: path.resolve(__dirname, '..', 'logs', 'out.log'),
      merge_logs: true,
      time: true,

      // Give in-flight M-Pesa callbacks a moment to finish.
      kill_timeout: 5000
    }
  ]
};