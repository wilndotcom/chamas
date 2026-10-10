/**
 * Build identity.
 *
 * Without this, two copies of THE TEAM are indistinguishable: a bug report
 * from a client's server cannot be traced to a version, so it is impossible to
 * tell a bug from a fork.
 *
 * BUILD_ID should be stamped at deploy time from the commit being shipped:
 *
 *     BUILD_ID=$(git rev-parse --short HEAD) npm start
 *
 * When it is not supplied, the date is used instead. That is weaker, because
 * two deployments on the same day look identical, which is why
 * `ecosystem.config.js` sets it.
 */

const pkg = require('../package.json');

const fallbackDate = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

module.exports = {
  APP_NAME: 'THE TEAM',
  APP_VERSION: pkg.version || '0.0.0',
  BUILD_ID: process.env.BUILD_ID || `local-${fallbackDate()}`,
  // Stamped once at first boot so every later restart reports the same build.
  get bootedAt() {
    return process.env.BOOTED_AT || new Date().toISOString();
  }
};