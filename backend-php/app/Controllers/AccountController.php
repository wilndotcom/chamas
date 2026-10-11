<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Database;
use TheTeam\Env;
use TheTeam\Log;
use TheTeam\RateLimit;
use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Utils\Notifier;

/**
 * Password reset and two-factor login.
 *
 * A port of backend/controllers/accountController.js.
 *
 * Both work the same way on purpose: a short random code is generated, only its
 * hash is stored, and the plaintext goes through a channel the user already has.
 * Delivery is not this file's business - it goes through the notifier, so a group
 * without an SMS provider still gets the right response shape and the admin can
 * see why nothing arrived.
 *
 * The alternative - mailing a reset link - assumes an SMTP server this app does
 * not otherwise need, and would break for most chamas.
 */
final class AccountController
{
    private const CODE_TTL_MINUTES = 30;
    private const TWO_FACTOR_TTL_MINUTES = 10;
    private const MAX_TWO_FACTOR_ATTEMPTS = 5;

    /**
     * How long a locked-out administrator waits.
     *
     * Long enough that a lockout cannot be used to take somebody out of the app at
     * a meeting, short enough to be an inconvenience rather than an incident.
     */
    private const LOCKOUT_MINUTES = 15;

    /** Bcrypt work factor. Matches the Node side. */
    private const BCRYPT_COST = 12;

    /**
     * The single answer to "does this account exist".
     *
     * Deliberately vague and deliberately identical for both outcomes. Answering
     * differently for a real account and a made-up one turns this endpoint into a
     * way to enumerate who is registered, which is worth far more to an attacker
     * than a forgotten password. The real difference is visible only in the log.
     */
    private const UNKNOWN_ACCOUNT_MESSAGE =
        'If that account exists, a reset code has been sent to the number on the account.';

    public static function sha256($value): string
    {
        return hash('sha256', (string) $value);
    }

    /**
     * A short numeric code.
     *
     * Digits only, so it can be read aloud over a phone without "did you say
     * seven or one". crypto_random_int is a CSPRNG rather than rand(): a
     * predictable reset code is not a second factor at all.
     */
    public static function makeNumericCode(int $digits = 6): string
    {
        $code = '';

        for ($i = 0; $i < $digits; $i++) {
            $code .= (string) random_int(0, 9);
        }

        return $code;
    }

    /**
     * Starts a password reset.
     *
     * Always reports success, whether or not the account exists.
     */
    public static function requestPasswordReset(Request $r): void
    {
        $body = $r->body();
        $who = trim((string) ($body['identifier'] ?? ''));

        if ($who === '') {
            Response::error('Enter your username, email or phone number.', 400);
        }

        /*
         * On its own counter, separate from login.
         *
         * A reset code is six digits, so without this it would be a far cheaper
         * thing to guess than a password. Limiting login attempts protects work
         * that bcrypt makes expensive; an unlimited reset flow protects nothing.
         */
        if (!RateLimit::hit('password-reset', $r->ip(), 8, 15 * 60)) {
            Response::error('Too many attempts. Please wait 15 minutes and try again.', 429);
        }

        $principalType = ($body['type'] ?? null) === 'member' ? 'member' : 'admin';

        try {
            $principal = $principalType === 'member'
                ? self::findMember($who)
                : self::findAdmin($who);

            if ($principal === null) {
                // Logged, not answered. The difference is real and belongs in the
                // server's own record, not in the response.
                Log::startup("[reset] requested for unknown {$principalType}: {$who}");
                Response::json(['success' => true, 'message' => self::UNKNOWN_ACCOUNT_MESSAGE]);
            }

            /*
             * One live code at a time.
             *
             * Issuing a second silently would let an older code keep working, or
             * make the newest one fail because the user tried the previous first.
             */
            Database::run(
                'DELETE FROM password_resets
                  WHERE principal_type = ? AND principal_id = ? AND used_at IS NULL',
                [$principalType, $principal['id']]
            );

            $code = self::makeNumericCode();
            $expiresAt = (new \DateTimeImmutable('now'))
                ->modify('+' . self::CODE_TTL_MINUTES . ' minutes');

            $contact = (string) ($principal['phone'] ?: $principal['email']);
            $hint = self::maskContact($contact);

            Database::run(
                'INSERT INTO password_resets (principal_type, principal_id, token_hash, contact_hint, expires_at)
                 VALUES (?, ?, ?, ?, ?)',
                [$principalType, $principal['id'], self::sha256($code), $hint, $expiresAt->format('Y-m-d H:i:s')]
            );

            $delivery = Notifier::dispatch('sms', (string) ($principal['phone'] ?: $principal['email']),
                sprintf(
                    'Your %s password reset code is %s. It is valid for %d minutes. '
                    . 'If you did not ask for this, tell your super admin straight away.',
                    $principal['full_name'],
                    $code,
                    self::CODE_TTL_MINUTES
                )
            );

            Log::startup("[reset] code issued for {$principalType} {$principal['id']} ({$hint})");

            Response::json([
                'success' => true,

                // Whether the message actually went out is reported, because a
                // silent failure looks identical to a user who never got the code -
                // and a user who never got the code cannot get in.
                'delivered' => (bool) ($delivery['success'] ?? false),
                'delivery_note' => ($delivery['success'] ?? false)
                    ? null
                    : ($delivery['reason'] ?? 'No notification channel is configured.'),
                'hint' => $hint,
                'expires_in_minutes' => self::CODE_TTL_MINUTES,
            ] + (Env::get('NODE_ENV') === 'production' ? [] : ['dev_code' => $code]) + [
                // Byte-identical to the unknown-account message above. These two
                // responses differed in wording once, which quietly gave away
                // which accounts exist.
                'message' => self::UNKNOWN_ACCOUNT_MESSAGE,
            ]);
        } catch (\Throwable $e) {
            Log::warn('requestPasswordReset: ' . $e->getMessage());
            Response::error('Could not start the reset. Please try again.', 500);
        }
    }

    /**
     * Completes a reset.
     *
     * The code is compared against the stored hash and must not already be used or
     * expired. Then the password changes and every outstanding code is killed, so a
     * code captured earlier cannot be replayed afterwards.
     */
    public static function completePasswordReset(Request $r): void
    {
        $body = $r->body();
        $who = trim((string) ($body['identifier'] ?? ''));
        $submitted = trim((string) ($body['code'] ?? ''));
        $newPassword = (string) ($body['new_password'] ?? '');

        if ($who === '' || $submitted === '' || $newPassword === '') {
            Response::error('Enter your account, the code and the new password.', 400);
        }

        if (strlen($newPassword) < 8) {
            Response::error('The new password must be at least 8 characters.', 400);
        }

        if (!RateLimit::hit('password-reset', $r->ip(), 8, 15 * 60)) {
            Response::error('Too many attempts. Please wait 15 minutes and try again.', 429);
        }

        $principalType = ($body['type'] ?? null) === 'member' ? 'member' : 'admin';

        // One message for every failure, so a wrong code cannot be told apart from
        // an expired one and used to probe which was which.
        $reject = static fn() => Response::error(
            'That code is not valid. It may have been used already, or it may have expired.',
            400
        );

        try {
            $reset = Database::one(
                <<<'SQL'
                    SELECT r.id AS reset_id, r.principal_id, r.expires_at, r.used_at
                      FROM password_resets r
                     WHERE r.principal_type = ? AND r.token_hash = ?
                     ORDER BY r.created_at DESC
                     LIMIT 1
                    SQL,
                [$principalType, self::sha256($submitted)]
            );

            if ($reset === null) {
                $reject();
            }

            if (!empty($reset['used_at'])) {
                $reject();
            }

            $expires = strtotime((string) $reset['expires_at']);
            if ($expires === false || $expires < time()) {
                $reject();
            }

            $table = $principalType === 'member' ? 'members' : 'admins';

            $hash = password_hash($newPassword, PASSWORD_BCRYPT, ['cost' => self::BCRYPT_COST]);

            Database::transaction(function ($pdo) use ($table, $hash, $reset, $principalType): void {
                $pdo->prepare("UPDATE {$table} SET password_hash = ? WHERE id = ?")
                    ->execute([$hash, $reset['principal_id']]);

                // Marks this code used and kills any others still open.
                $pdo->prepare(
                    'UPDATE password_resets SET used_at = NOW()
                      WHERE principal_type = ? AND principal_id = ? AND used_at IS NULL'
                )->execute([$principalType, $reset['principal_id']]);
            });

            // Recorded so a password changed this way can be explained in an audit.
            // Best effort: the password has already changed, and refusing here
            // would be worse than skipping the note.
            try {
                Database::run(
                    'INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details)
                     VALUES (?, \'password_reset\', ?, ?, ?)',
                    [
                        $principalType === 'admin' ? $reset['principal_id'] : null,
                        $principalType,
                        $reset['principal_id'],
                        json_encode(['via' => 'reset_code']),
                    ]
                );
            } catch (\Throwable) {
                // The audit table may not have these columns on an older install.
            }

            Log::startup("[reset] password changed for {$principalType} {$reset['principal_id']}");

            Response::json([
                'success' => true,
                'message' => 'Your password has been changed. Sign in with it now.',
            ]);
        } catch (\Throwable $e) {
            Log::warn('completePasswordReset: ' . $e->getMessage());
            Response::error('Could not change the password. Please try again.', 500);
        }
    }

    /**
     * Issues a two-factor code for an admin who has the feature switched on.
     *
     * Returns the code outside production only. Shipping it in the response would
     * make the second factor decorative.
     */
    public static function issueTwoFactorCode(Request $r): void
    {
        try {
            $admin = Database::one(
                'SELECT id, full_name, phone, email, two_factor_enabled FROM admins WHERE id = ?',
                [$r->user['id']]
            );

            if ($admin === null) {
                Response::error('Admin not found.', 404);
            }

            if (!$admin['two_factor_enabled']) {
                Response::json(['required' => false]);
            }

            $code = self::makeNumericCode(6);
            $expiresAt = (new \DateTimeImmutable('now'))
                ->modify('+' . self::TWO_FACTOR_TTL_MINUTES . ' minutes');

            Database::run(
                'INSERT INTO two_factor_codes (admin_id, code_hash, expires_at) VALUES (?, ?, ?)',
                [$admin['id'], self::sha256($code), $expiresAt->format('Y-m-d H:i:s')]
            );

            $delivery = Notifier::dispatch(
                'sms',
                (string) ($admin['phone'] ?: $admin['email']),
                sprintf(
                    'Your sign-in code is %s. Valid for %d minutes.',
                    $code,
                    self::TWO_FACTOR_TTL_MINUTES
                )
            );

            if (!($delivery['success'] ?? false)) {
                Log::warn('[2fa] could not deliver code: ' . ($delivery['reason'] ?? ''));
            }

            Response::json(array_merge([
                'required' => true,
                'delivered' => (bool) ($delivery['success'] ?? false),
                'delivery_note' => ($delivery['success'] ?? false)
                    ? null
                    : ($delivery['reason'] ?? 'No notification channel is configured.'),
                'expires_in_minutes' => self::TWO_FACTOR_TTL_MINUTES,
            ], Env::get('NODE_ENV') === 'production' ? [] : ['dev_code' => $code]));
        } catch (\Throwable $e) {
            Log::warn('issueTwoFactorCode: ' . $e->getMessage());
            Response::error('Could not send a sign-in code.', 500);
        }
    }

    /**
     * Checks a two-factor code.
     *
     * Attempts are counted per administrator, not per code, so a guessed code
     * costs exactly as much as a correct one.
     */
    public static function verifyTwoFactorCode(Request $r): void
    {
        try {
            $code = trim((string) ($r->body()['code'] ?? ''));

            $admin = Database::one(
                'SELECT two_factor_failures, two_factor_locked_until FROM admins WHERE id = ?',
                [$r->user['id']]
            );

            if ($admin === null) {
                Response::error('Admin not found.', 404);
            }

            /*
             * Locked out? Refused before the code is even looked at.
             *
             * The counter lives on the admin, not on a code, and that is the whole
             * point. A guessed code almost never matches a row at all, so a
             * per-code counter never moves and a million guesses cost nothing.
             * This one moves on every wrong attempt.
             */
            if (!empty($admin['two_factor_locked_until'])) {
                $until = strtotime((string) $admin['two_factor_locked_until']);

                if ($until !== false && $until > time()) {
                    $minutes = max(1, (int) ceil(($until - time()) / 60));
                    Response::error("Too many wrong codes. Try again in {$minutes} minute(s).", 429);
                }

                // The window has passed, so the slate is cleared.
                Database::run(
                    'UPDATE admins SET two_factor_failures = 0, two_factor_locked_until = NULL
                      WHERE id = ?',
                    [$r->user['id']]
                );
            }

            if ($code === '') {
                Response::error('Enter the code sent to your phone.', 400);
            }

            $row = Database::one(
                'SELECT id, expires_at, used_at FROM two_factor_codes
                  WHERE admin_id = ? AND code_hash = ?
                  ORDER BY created_at DESC LIMIT 1',
                [$r->user['id'], self::sha256($code)]
            );

            $expires = $row ? strtotime((string) $row['expires_at']) : false;

            $usable = $row !== null
                && empty($row['used_at'])
                && $expires !== false
                && $expires > time();

            if (!$usable) {
                self::recordTwoFactorFailure($r->user['id']);
                Response::error('That code is not valid. Ask for a new one.', 400);
            }

            // Right code: it is spent, and the failure count starts again from
            // zero.
            Database::transaction(function ($pdo) use ($row, $r): void {
                $pdo->prepare('UPDATE two_factor_codes SET used_at = NOW() WHERE id = ?')
                    ->execute([$row['id']]);

                $pdo->prepare(
                    'UPDATE admins SET two_factor_failures = 0, two_factor_locked_until = NULL
                      WHERE id = ?'
                )->execute([$r->user['id']]);
            });

            Response::json(['success' => true, 'verified' => true]);
        } catch (\Throwable $e) {
            Log::warn('verifyTwoFactorCode: ' . $e->getMessage());
            Response::error('Could not check that code.', 500);
        }
    }

    /**
     * Counts a wrong code and locks the administrator out once the limit is passed.
     *
     * The count and the lock are set in one statement so two simultaneous guesses
     * cannot both read "four failures" and both write "five", letting more than
     * the intended number through.
     */
    private static function recordTwoFactorFailure($adminId): void
    {
        Database::run(
            <<<'SQL'
                UPDATE admins
                   SET two_factor_failures = two_factor_failures + 1,
                       two_factor_locked_until = CASE
                         WHEN two_factor_failures + 1 >= ?
                         THEN DATE_ADD(NOW(), INTERVAL ? MINUTE)
                         ELSE two_factor_locked_until
                       END
                 WHERE id = ?
                SQL,
            [self::MAX_TWO_FACTOR_ATTEMPTS, self::LOCKOUT_MINUTES, $adminId]
        );
    }

    /** Switches the second factor on or off for the signed-in admin. */
    public static function setTwoFactor(Request $r): void
    {
        try {
            $enabled = !empty($r->body()['enabled']);
            $adminId = $r->user['id'];

            Database::transaction(function ($pdo) use ($enabled, $adminId): void {
                $pdo->prepare('UPDATE admins SET two_factor_enabled = ? WHERE id = ?')
                    ->execute([$enabled ? 1 : 0, $adminId]);

                // Turning it off discards any code already issued, so one sent
                // before the change cannot be used afterwards.
                if (!$enabled) {
                    $pdo->prepare(
                        'UPDATE two_factor_codes SET used_at = NOW()
                          WHERE admin_id = ? AND used_at IS NULL'
                    )->execute([$adminId]);
                }
            });

            Response::json([
                'success' => true,
                'two_factor_enabled' => $enabled,
                'message' => $enabled
                    ? 'A code will now be sent to your phone each time you sign in.'
                    : 'The second code is no longer required.',
            ]);
        } catch (\Throwable $e) {
            Log::warn('setTwoFactor: ' . $e->getMessage());
            Response::error('Could not change that setting.', 500);
        }
    }

    // -------------------------------------------------------------- helpers

    /**
     * Members sign in with a phone number; administrators with a username or
     * email. Both spellings are accepted so the screen need not ask which.
     */
    private static function findMember(string $who): ?array
    {
        $digits = preg_replace('/[^0-9]/', '', $who) ?? '';
        $international = str_starts_with($digits, '0') ? '254' . substr($digits, 1) : $digits;

        return Database::one(
            'SELECT id, full_name, phone, email, status FROM members
              WHERE phone = ? OR (? <> \'\' AND phone = ?)',
            [$who, $digits, $international]
        );
    }

    private static function findAdmin(string $who): ?array
    {
        return Database::one(
            'SELECT id, full_name, email, phone FROM admins
              WHERE username = ? OR email = ? OR phone = ?',
            [$who, $who, $who]
        );
    }

    /** A contact with its middle hidden, so it can be shown back safely. */
    private static function maskContact(string $contact): string
    {
        if (strlen($contact) <= 7) {
            return $contact === '' ? '' : substr($contact, 0, 1) . '***';
        }

        return substr($contact, 0, 4) . '***' . substr($contact, -3);
    }
}