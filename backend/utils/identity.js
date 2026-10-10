/**
 * Installation identity.
 *
 * A random id generated on first boot and stored in settings, so it survives
 * restarts, rebuilds and upgrades. It identifies an *installation*, not a
 * person: it is generated locally and never derived from member data.
 *
 * What this is for
 *   - telling a bug report against 1.0.0 apart from one against someone's fork
 *   - letting the developer confirm which build a client is running
 *
 * What this is NOT
 *   - it does not phone home. Nothing leaves the machine unless the operator
 *     configures a reporting endpoint themselves.
 *   - it carries no member names, phone numbers or financial figures.
 *
 * Report it when asked, or when the operator has deliberately enabled
 * `WILNCOM_REPORT_URL`. Reporting is opt-in and disclosed in Settings.
 */

const crypto = require('crypto');
const pool = require('../config/database');

let cached = null;

const getInstallId = async () => {
  if (cached) return cached;

  try {
    const [rows] = await pool.execute(
      "SELECT setting_value FROM settings WHERE setting_key = 'install_id'"
    );

    if (rows.length && rows[0].setting_value) {
      cached = rows[0].setting_value;
      return cached;
    }

    const generated = crypto.randomUUID();
    await pool.execute(
      `INSERT INTO settings (setting_key, setting_value, description)
       VALUES ('install_id', ?, 'Unique id for this installation. Generated locally on first boot.')
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [generated]
    );

    cached = generated;
    return cached;
  } catch (error) {
    // Identity is a convenience, never a hard dependency. A fresh id per boot is
    // harmless: it just means two reports of the same install look unrelated.
    console.warn('[identity] could not read install_id:', error.message);
    cached = `ephemeral-${crypto.randomUUID()}`;
    return cached;
  }
};

/**
 * Everything needed to recognise a build, and nothing that identifies a member.
 *
 * @param {number} memberCount how many members are on file, as an aggregate
 */
const getBuildInfo = async (memberCount = 0) => {
  const version = require('../config/version');
  return {
    app: version.APP_NAME,
    version: version.APP_VERSION,
    build: version.BUILD_ID,
    install_id: await getInstallId(),
    // Aggregate only. Never names, phone numbers, balances or savings totals.
    member_count: Number(memberCount) || 0,
    licence: 'Non-Commercial MIT (see LICENSE)'
  };
};

module.exports = { getInstallId, getBuildInfo };