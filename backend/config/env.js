/**
 * Single place where environment variables are loaded.
 *
 * Why this exists: `server.js` and `config/database.js` used to each call
 * `dotenv.config()` on its own, which only ever reads `.env`. On a production
 * server the credentials live in `.env.production`, so those values were
 * silently ignored and the app booted with an empty DB_PASSWORD — a confusing
 * crash instead of a clear one.
 *
 * Rules:
 *  - The file matching NODE_ENV is loaded first and wins.
 *  - The other file is loaded second purely to fill gaps (dotenv never
 *    overwrites a variable that is already set).
 *  - A real environment variable injected by PM2/systemd always beats both.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
const isProd = process.env.NODE_ENV === 'production';

const primary = isProd ? '.env.production' : '.env';
const fallback = isProd ? '.env' : '.env.production';

const loaded = [];
[primary, fallback].forEach((name) => {
  const file = path.join(root, name);
  if (fs.existsSync(file)) {
    dotenv.config({ path: file });
    loaded.push(name);
  }
});

if (loaded.length === 0) {
  console.warn(
    '[env] No .env or .env.production found — falling back to real environment variables only.'
  );
} else {
  console.log(`[env] Loaded ${loaded.join(', ')} (NODE_ENV=${process.env.NODE_ENV || 'unset'})`);
}

// Catch the classic silent production failure early. Losing ten minutes to
// "Database connection failed: Access denied" is not a good use of anyone's
// afternoon, so say what is wrong while the log is still being read.
if (isProd) {
  const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET'];
  const missing = required.filter((k) => !process.env[k]);

  if (missing.length) {
    console.error(
      `[env] FATAL in production — missing: ${missing.join(', ')}. ` +
        'Put them in backend/.env.production.'
    );
  }

  const secret = process.env.JWT_SECRET || '';
  if (secret && secret.length < 32) {
    console.error('[env] FATAL in production — JWT_SECRET is shorter than 32 characters.');
  }
  if (secret.includes('change') || secret.includes('xxx') || secret.includes('your')) {
    console.error('[env] FATAL in production — JWT_SECRET is still the sample value.');
  }

  if (!process.env.FRONTEND_ORIGIN) {
    console.log(
      '[env] FRONTEND_ORIGIN not set — cross-origin API calls will be refused. ' +
        'This is expected when Nginx serves the frontend and proxies /api.'
    );
  }
}

module.exports = { loaded, isProd };