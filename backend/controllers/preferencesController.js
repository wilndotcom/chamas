const pool = require('../config/database');

/**
 * Per-user interface language.
 *
 * The `language` setting in Settings is the chama-wide default. This is the
 * individual override: a member who reads Kiswahili and an admin who does not can
 * both be served correctly instead of one forcing it on the other.
 *
 * `null` means "no opinion", which falls back to the global setting. That is why
 * the column is nullable and why clearing it is a valid request rather than an
 * error.
 *
 * The list here is the same one the frontend dictionary defines. The database
 * also enforces it with a CHECK constraint, so a code without a translation is
 * rejected rather than silently falling back to English and leaving the picker
 * blank.
 */
const SUPPORTED = ['en', 'sw'];

// Whitelisted table names, chosen by token type. Never interpolate a table name
// from user input.
const TABLES = { admin: 'admins', member: 'members' };

const tableFor = (req) => TABLES[req.user?.type];

/** Reads the signed-in user's language, or null when they have not chosen one. */
const getMyLanguage = async (req, res) => {
  try {
    const table = tableFor(req);
    if (!table) return res.status(403).json({ error: 'Unknown account type.' });

    const [rows] = await pool.execute(`SELECT language FROM ${table} WHERE id = ?`, [
      req.user.id
    ]);
    if (rows.length === 0) return res.status(404).json({ error: 'Account not found.' });

    res.json({ language: rows[0].language || null, supported: SUPPORTED });
  } catch (error) {
    console.error('Get language failed:', error);
    res.status(500).json({ error: 'Failed to read your language preference.' });
  }
};

/**
 * Saves the signed-in user's language.
 *
 * Sending null clears the override so the user follows the chama-wide setting
 * again, which is the honest way to express "I have no preference".
 */
const setMyLanguage = async (req, res) => {
  try {
    const table = tableFor(req);
    if (!table) return res.status(403).json({ error: 'Unknown account type.' });

    const { language } = req.body || {};

    if (language !== null && language !== undefined && !SUPPORTED.includes(language)) {
      return res.status(400).json({
        error: `Language must be one of: ${SUPPORTED.join(', ')}, or empty to follow the group default.`
      });
    }

    const value = language || null;

    const [result] = await pool.execute(`UPDATE ${table} SET language = ? WHERE id = ?`, [
      value,
      req.user.id
    ]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    res.json({
      success: true,
      language: value,
      message: value
        ? 'Language saved.'
        : 'Now following the group default language.'
    });
  } catch (error) {
    // A CHECK constraint violation means someone posted a code we do not have a
    // translation for. Say which codes are valid instead of a generic failure.
    if (error.code === 'ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE' || /chk_.*_language/.test(error.sqlMessage || '')) {
      return res.status(400).json({
        error: `Language must be one of: ${SUPPORTED.join(', ')}.`
      });
    }
    console.error('Set language failed:', error);
    res.status(500).json({ error: 'Failed to save your language preference.' });
  }
};

module.exports = { getMyLanguage, setMyLanguage, SUPPORTED };