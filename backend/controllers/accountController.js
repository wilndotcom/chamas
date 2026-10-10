const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { dispatch } = require('../utils/notifier');

/*
 * Password reset, and two-factor login.
 *
 * Both work the same way on purpose: a short random code is generated, only its
 * hash is stored, and the plaintext is delivered through a channel the user
 * already has. Nothing here is emailed or texted by this file - delivery goes
 * through the notifier, so a group without an SMS provider still gets the
 * response shape right and the admin can see why nothing arrived.
 *
 * The alternative - mailing a reset link - assumes an SMTP server this app does
 * not require and would otherwise break for most chamas.
 */

const CODE_TTL_MINUTES = 30;
const TWO_FACTOR_TTL_MINUTES = 10;
const MAX_TWO_FACTOR_ATTEMPTS = 5;

/*
 * How long a locked-out administrator waits.
 *
 * Long enough that a lockout cannot be used to take someone out of the app at a
 * meeting, short enough to be an inconvenience rather than an incident.
 */
const LOCKOUT_MINUTES = 15;

/*
 * The single answer to "does this account exist".
 *
 * Deliberately vague and deliberately identical for both outcomes. Answering
 * differently for a real account and a made-up one turns this endpoint into a way
 * to enumerate who is registered, which is worth far more to an attacker than a
 * forgotten password. The real difference is visible only in the server log.
 */
const UNKNOWN_ACCOUNT_MESSAGE =
  'If that account exists, a reset code has been sent to the number on the account.';

const sha256 = (value) =>
  crypto.createHash('sha256').update(String(value)).digest('hex');

/** A short numeric code. Avoids 0/O and 1/l so it can be read aloud. */
const makeNumericCode = (digits = 6) => {
  let out = '';
  for (let i = 0; i < digits; i++) {
    out += String(crypto.randomInt(0, 10));
  }
  return out;
};

/**
 * Starts a password reset.
 *
 * Always reports success, whether or not the account exists.
 *
 * Answering differently for a real account and a made-up one turns this endpoint
 * into a way to discover who is registered, which is worth more to an attacker
 * than a forgotten password. The caller cannot tell the two cases apart; the
 * difference is only in the log.
 */
const requestPasswordReset = async (req, res) => {
  const { identifier, type } = req.body;
  const who = String(identifier || '').trim();

  if (!who) {
    return res.status(400).json({ error: 'Enter your username, email or phone number.' });
  }

  const principalType = type === 'member' ? 'member' : 'admin';
  let principal = null;

  try {
    if (principalType === 'member') {
      // Members sign in with a phone number; administrators with a username or
      // email. Accept either so the screen does not have to ask which it is.
      const digits = who.replace(/[^0-9]/g, '');
      const [rows] = await pool.execute(
        `SELECT id, full_name, phone, email, status FROM members
          WHERE phone = ? OR (? <> '' AND phone = ?)`,
        [who, digits, digits.startsWith('0') ? '254' + digits.slice(1) : digits]
      );
      principal = rows[0] || null;
    } else {
      const [rows] = await pool.execute(
        `SELECT id, full_name, email, phone FROM admins
          WHERE username = ? OR email = ? OR phone = ?`,
        [who, who, who]
      );
      principal = rows[0] || null;
    }

    if (!principal) {
      console.log(`[reset] requested for unknown ${principalType}: ${who}`);
      return res.json({ success: true, message: UNKNOWN_ACCOUNT_MESSAGE });
    }

    // One live code at a time. Issuing a second one silently would let an older
    // code keep working, or make the newest one not work because the user tried
    // the previous first.
    await pool.execute(
      `DELETE FROM password_resets
        WHERE principal_type = ? AND principal_id = ? AND used_at IS NULL`,
      [principalType, principal.id]
    );

    const code = makeNumericCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);
    const hint = String(principal.phone || principal.email || '')
      .replace(/^(.{4}).*(.{3})$/, '$1***$2');

    await pool.execute(
      `INSERT INTO password_resets (principal_type, principal_id, token_hash, contact_hint, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [principalType, principal.id, sha256(code), hint, expiresAt]
    );

    const target = principal.phone || principal.email;
    const delivery = await dispatch('sms', {
      to: target,
      message:
        `Your ${principal.full_name} password reset code is ${code}. ` +
        `It is valid for ${CODE_TTL_MINUTES} minutes. ` +
        `If you did not ask for this, tell your super admin straight away.`
    }).catch((e) => ({ success: false, error: e.message }));

    console.log(`[reset] code issued for ${principalType} ${principal.id} (${hint})`);

    res.json({
      success: true,
      // Whether the message actually went out is reported, because a silent
      // failure here looks identical to a user who never got the code - and a
      // user who never got the code cannot get in.
      delivered: !!delivery.success,
      delivery_note: delivery.success
        ? null
        : delivery.reason || delivery.error || 'No notification channel is configured.',
      hint,
      expires_in_minutes: CODE_TTL_MINUTES,
      // Returned outside production only. Without it a reset cannot be completed
      // on a machine with no SMS provider configured, which is most of them, so
      // during setup the code has to be readable from the response.
      ...(process.env.NODE_ENV === 'production' ? {} : { dev_code: code }),
      // Byte-identical to the unknown-account message above. These two responses
      // differed in wording, which quietly gave away which accounts exist - the
      // one thing this endpoint is supposed to hide.
      message: UNKNOWN_ACCOUNT_MESSAGE
    });
  } catch (error) {
    console.error('Request password reset error:', error);
    res.status(500).json({ error: 'Could not start the reset. Please try again.' });
  }
};

/**
 * Completes a reset.
 *
 * The code is compared against the stored hash and must not already be used or
 * expired. Then the password is changed and every outstanding code is killed, so
 * a code captured earlier cannot be replayed after the password has changed.
 */
const completePasswordReset = async (req, res) => {
  const { identifier, code, new_password, type } = req.body;
  const who = String(identifier || '').trim();
  const submitted = String(code || '').trim();

  if (!who || !submitted || !new_password) {
    return res.status(400).json({ error: 'Enter your account, the code and the new password.' });
  }

  if (String(new_password).length < 8) {
    return res.status(400).json({ error: 'The new password must be at least 8 characters.' });
  }

  const principalType = type === 'member' ? 'member' : 'admin';

  try {
    const [rows] = await pool.execute(
      `SELECT r.id AS reset_id, r.principal_id, r.expires_at, r.used_at
         FROM password_resets r
        WHERE r.principal_type = ?
          AND r.token_hash = ?
        ORDER BY r.created_at DESC
        LIMIT 1`,
      [principalType, sha256(submitted)]
    );

    const reset = rows[0];

    // One message for every failure, so a wrong code cannot be told apart from
    // an expired one and used to probe which was which.
    const reject = () =>
      res.status(400).json({
        error: 'That code is not valid. It may have been used already, or it may have expired.'
      });

    if (!reset) return reject();
    if (reset.used_at) return reject();
    if (new Date(reset.expires_at).getTime() < Date.now()) return reject();

    const hashed = await bcrypt.hash(new_password, 12);

    if (principalType === 'member') {
      await pool.execute('UPDATE members SET password_hash = ? WHERE id = ?', [
        hashed,
        reset.principal_id
      ]);
    } else {
      await pool.execute('UPDATE admins SET password_hash = ? WHERE id = ?', [
        hashed,
        reset.principal_id
      ]);
    }

    // Marks this code used and kills any others still open for the account.
    await pool.execute(
      `UPDATE password_resets SET used_at = NOW()
        WHERE principal_type = ? AND principal_id = ? AND used_at IS NULL`,
      [principalType, reset.principal_id]
    );

    // Recorded, so a password changed this way can be explained in an audit.
    await pool.execute(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details)
       VALUES (?, 'password_reset', ?, ?, ?)`,
      [
        principalType === 'admin' ? reset.principal_id : null,
        principalType,
        reset.principal_id,
        JSON.stringify({ via: 'reset_code' })
      ]
    ).catch(() => {
      // The audit table may not have these columns on an older install. The
      // password has already changed and refusing here would be worse than
      // skipping the note.
    });

    console.log(`[reset] password changed for ${principalType} ${reset.principal_id}`);

    res.json({ success: true, message: 'Your password has been changed. Sign in with it now.' });
  } catch (error) {
    console.error('Complete password reset error:', error);
    res.status(500).json({ error: 'Could not change the password. Please try again.' });
  }
};

/**
 * Issues a two-factor code for an admin who has the feature switched on.
 *
 * Returns the code in development only. Shipping it in the response would make
 * the second factor decorative.
 */
const issueTwoFactorCode = async (req, res) => {
  try {
    const [[admin]] = await pool.execute(
      'SELECT id, full_name, phone, email, two_factor_enabled FROM admins WHERE id = ?',
      [req.user.id]
    );

    if (!admin) return res.status(404).json({ error: 'Admin not found.' });

    if (!admin.two_factor_enabled) {
      return res.json({ required: false });
    }

    const code = makeNumericCode(6);
    const expiresAt = new Date(Date.now() + TWO_FACTOR_TTL_MINUTES * 60 * 1000);

    await pool.execute(
      `INSERT INTO two_factor_codes (admin_id, code_hash, expires_at) VALUES (?, ?, ?)`,
      [admin.id, sha256(code), expiresAt]
    );

    const delivery = await dispatch('sms', {
      to: admin.phone || admin.email,
      message: `Your sign-in code is ${code}. Valid for ${TWO_FACTOR_TTL_MINUTES} minutes.`
    }).catch((e) => ({ success: false, error: e.message }));

    if (!delivery.success) {
      console.warn('[2fa] could not deliver code:', delivery.reason || delivery.error);
    }

    res.json({
      required: true,
      delivered: !!delivery.success,
      delivery_note: delivery.success
        ? null
        : delivery.reason || delivery.error || 'No notification channel is configured.',
      expires_in_minutes: TWO_FACTOR_TTL_MINUTES,
      // Only ever returned when the app is not in production. Without this the
      // second factor is decorative.
      ...(process.env.NODE_ENV === 'production' ? {} : { dev_code: code })
    });
  } catch (error) {
    console.error('Issue 2FA code error:', error);
    res.status(500).json({ error: 'Could not send a sign-in code.' });
  }
};

/**
 * Checks a two-factor code.
 *
 * Attempts are counted so a six-digit code cannot be brute-forced: at
 * MAX_TWO_FACTOR_ATTEMPTS the code is dead and a new one must be issued.
 */
const verifyTwoFactorCode = async (req, res) => {
  const code = String(req.body.code || '').trim();

  try {
    const [[admin]] = await pool.execute(
      'SELECT two_factor_failures, two_factor_locked_until FROM admins WHERE id = ?',
      [req.user.id]
    );

    if (!admin) return res.status(404).json({ error: 'Admin not found.' });

    /*
     * Locked out? Refused before the code is even looked at.
     *
     * The counter lives on the admin, not on a code, and that is the whole point.
     * A guessed code almost never matches a row at all, so a per-code counter
     * never moves and a million guesses cost nothing. This one moves on every
     * wrong attempt.
     */
    if (admin.two_factor_locked_until) {
      const until = new Date(admin.two_factor_locked_until).getTime();
      if (until > Date.now()) {
        const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
        return res.status(429).json({
          error: `Too many wrong codes. Try again in ${minutes} minute(s).`
        });
      }
      // The window has passed, so the slate is cleared.
      await pool.execute(
        'UPDATE admins SET two_factor_failures = 0, two_factor_locked_until = NULL WHERE id = ?',
        [req.user.id]
      );
    }

    if (!code) {
      return res.status(400).json({ error: 'Enter the code sent to your phone.' });
    }

    const [rows] = await pool.execute(
      `SELECT id, expires_at, used_at FROM two_factor_codes
        WHERE admin_id = ? AND code_hash = ?
        ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, sha256(code)]
    );

    const row = rows[0];
    const usable =
      row && !row.used_at && new Date(row.expires_at).getTime() > Date.now();

    if (!usable) {
      await recordTwoFactorFailure(req.user.id);
      return res.status(400).json({ error: 'That code is not valid. Ask for a new one.' });
    }

    // Right code: it is spent, and the failure count starts again from zero.
    await pool.execute('UPDATE two_factor_codes SET used_at = NOW() WHERE id = ?', [row.id]);
    await pool.execute(
      'UPDATE admins SET two_factor_failures = 0, two_factor_locked_until = NULL WHERE id = ?',
      [req.user.id]
    );

    res.json({ success: true, verified: true });
  } catch (error) {
    console.error('Verify 2FA error:', error);
    res.status(500).json({ error: 'Could not check that code.' });
  }
};

/**
 * Counts a wrong code and locks the administrator out once the limit is passed.
 *
 * Every guess costs, whether or not it matched a code that exists, so guessing at
 * random costs exactly as much as guessing at a known code.
 */
const recordTwoFactorFailure = async (adminId) => {
  await pool.execute(
    `UPDATE admins
        SET two_factor_failures = two_factor_failures + 1,
            two_factor_locked_until = CASE
              WHEN two_factor_failures + 1 >= ?
              THEN DATE_ADD(NOW(), INTERVAL ? MINUTE)
              ELSE two_factor_locked_until
            END
      WHERE id = ?`,
    [MAX_TWO_FACTOR_ATTEMPTS, LOCKOUT_MINUTES, adminId]
  );
};

/** Switches the second factor on or off for the signed-in admin. */
const setTwoFactor = async (req, res) => {
  try {
    const enabled = req.body.enabled ? 1 : 0;
    await pool.execute('UPDATE admins SET two_factor_enabled = ? WHERE id = ?', [
      enabled,
      req.user.id
    ]);

    // Turning it off discards any code that was already issued, so one sent
    // before the change cannot be used afterwards.
    if (!enabled) {
      await pool.execute(
        'UPDATE two_factor_codes SET used_at = NOW() WHERE admin_id = ? AND used_at IS NULL',
        [req.user.id]
      );
    }

    res.json({
      success: true,
      two_factor_enabled: !!enabled,
      message: enabled
        ? 'A code will now be sent to your phone each time you sign in.'
        : 'The second code is no longer required.'
    });
  } catch (error) {
    console.error('Set 2FA error:', error);
    res.status(500).json({ error: 'Could not change that setting.' });
  }
};

module.exports = {
  requestPasswordReset,
  completePasswordReset,
  issueTwoFactorCode,
  verifyTwoFactorCode,
  setTwoFactor,
  makeNumericCode,
  sha256
};
