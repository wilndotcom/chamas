<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Auth;
use TheTeam\Database;
use TheTeam\Log;
use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Utils\Phone;

/**
 * Authentication, registration and impersonation.
 *
 * A port of backend/controllers/authController.js. The response shapes, status
 * codes and error strings are copied exactly: the React frontend branches on
 * them, and a "helpful" reword would break the portal with no obvious cause.
 *
 * bcrypt is used through password_hash/verify rather than a library, because
 * they are the same algorithm and produce hashes Node's bcryptjs can read. A
 * member's existing password therefore keeps working, which is the only way to
 * switch the backend without locking everybody out.
 */
final class AuthController
{
    /**
     * Bcrypt work factor.
     *
     * A cost, not an algorithm: it is passed as password_hash()'s third
     * argument. Passing it as the second asks for an algorithm called "12",
     * which fails and takes password changes down with it. Matches the Node
     * side, so existing passwords keep verifying on either backend.
     */
    private const BCRYPT_COST = 12;

    public static function adminLogin(Request $r): void
    {
        // Accepted as either the admin's username or their email address, which
        // is what the login form sends.
        $body = $r->body();
        $login = $body['identifier'] ?? $body['email'] ?? $body['username'] ?? null;
        $password = $body['password'] ?? null;

        if (!is_string($login) || trim($login) === '' || !is_string($password) || $password === '') {
            Response::error('Enter your username or email, and your password.', 400);
        }

        $login = trim($login);

        // One lookup covers both. MySQL's default collation is case-insensitive,
        // so "Admin" and "admin" resolve to the same account.
        // Heredoc, not backticks. In PHP a backtick is shell execution, not a
        // string delimiter - `` `SELECT ...` `` silently runs a command and yields
        // null, so the query arrives empty and the failure surfaces far from the
        // cause. Heredoc is the delimiter for SQL.
        $admin = Database::one(
            <<<'SQL'
                SELECT a.*, r.name AS role
                  FROM admins a
                  JOIN roles r ON a.role_id = r.id
                 WHERE a.username = ? OR a.email = ?
                 LIMIT 1
                SQL,
            [$login, $login]
        );

        if ($admin === null) {
            // A hash is still computed on this path so a wrong username and a
            // wrong password take the same time. Without it the response time
            // tells an attacker which usernames exist.
            password_verify($password, '$2y$12$usesomesillystringforsalt0123456789abcdefghijklmnopq');
            Response::error('Invalid username/email or password.', 401);
        }

        if (!password_verify($password, $admin['password_hash'])) {
            Response::error('Invalid username/email or password.', 401);
        }

        if (!(bool) $admin['is_active']) {
            Response::error('Account is deactivated. Contact super admin.', 403);
        }

        // Permissions are resolved the same way Auth::require() does, so a login
        // and a later request report the same list. Two different code paths here
        // would mean the menu shows something the API then refuses.
        $principal = Auth::resolvePrincipal($admin['id'], 'admin');

        $token = Auth::issue([
            'id' => (int) $admin['id'],
            'email' => $admin['email'],
            'role' => $admin['role'],
            'type' => 'admin',
        ]);

        // Recorded so the admin list shows who is actually using the system.
        Database::run('UPDATE admins SET last_login = NOW() WHERE id = ?', [$admin['id']]);

        Response::json([
            'success' => true,
            'token' => $token,
            'admin' => [
                'id' => (int) $admin['id'],
                'member_id' => $admin['member_id'] !== null ? (int) $admin['member_id'] : null,
                'type' => 'admin',
                'full_name' => $admin['full_name'],
                'email' => $admin['email'],
                'phone' => $admin['phone'],
                'role' => $admin['role'],
                /*
                 * Sent with the login so the app can go straight to the change
                 * screen instead of loading a dashboard and having every request
                 * on it refused. The account is on the shared initial password
                 * until this clears.
                 */
                'must_change_password' => (bool) $admin['must_change_password'],
                'permissions' => $principal['permissions'],
            ],
        ]);
    }

    /**
 * A member applies to join the chama.
 *
 * The route has pointed here since the port began, and the method was never
 * written, so every application died on an undefined call. The symptom was an
 * HTML error page where the registration form expected JSON, which reads in the
 * browser as a parsing failure rather than as a missing endpoint.
 *
 * A direct translation of memberRegister in backend/controllers/authController.js.
 * The column default is also 'pending', but it is written here rather than
 * relied on: an application that silently became active would hand a stranger
 * access to the members' money.
 */
public static function memberRegister(Request $r): void
    {
        try {
            $body = $r->body();

            $fullName = trim((string) ($body['full_name'] ?? ''));
            $phone = trim((string) ($body['phone'] ?? ''));
            $password = (string) ($body['password'] ?? '');
            $confirm = $body['confirm_password'] ?? null;
            $email = trim((string) ($body['email'] ?? ''));
            $idNumber = trim((string) ($body['id_number'] ?? ''));

            if ($fullName === '' || $phone === '' || $password === '') {
                Response::error('Full name, phone and password are required.', 400);
            }

            if (strlen($password) < 6) {
                Response::error('Password must be at least 6 characters.', 400);
            }

            // Checked only when the form sent it. The API is public, and a
            // caller that omits the confirmation has not made a typo.
            if ($confirm !== null && $password !== (string) $confirm) {
                Response::error('Passwords do not match.', 400);
            }

            /*
             * The number is put into the one stored form, rather than checked
             * against a narrow pattern and stored as typed.
             *
             * A member copying their number off an M-Pesa confirmation brings
             * +254712345678, and that must be the same person as the 0712345678
             * already on file - otherwise one member is two rows, their payments
             * split across both, and neither balance is right.
             */
            $storedPhone = Phone::toMemberPhone($phone);

            if ($storedPhone === null) {
                Response::error(
                    'Enter a valid Kenyan phone number, e.g. 0712345678.',
                    400
                );
            }

            if ($idNumber !== '' && strlen($idNumber) < 6) {
                Response::error('That ID number looks too short.', 400);
            }

            /*
             * Which of the three refusals this is matters, and each is told
             * apart: "you already applied" tells somebody waiting to wait,
             * "declined" tells them to phone the office, and "already
             * registered" is the only one that should feel like a door closing.
             */
            $existing = Database::one('SELECT id, status FROM members WHERE phone = ?', [$storedPhone]);

            if ($existing !== null) {
                if ($existing['status'] === 'pending') {
                    Response::error('You already applied and are waiting for approval.', 409);
                }

                if ($existing['status'] === 'rejected') {
                    Response::error(
                        'Your application was declined. Please contact the chama office.',
                        409
                    );
                }

                Response::error('That phone number is already registered.', 409);
            }

            if ($email !== '') {
                $taken = Database::one('SELECT id FROM members WHERE email = ?', [$email]);

                if ($taken !== null) {
                    Response::error('That email address is already registered.', 409);
                }
            }

            $id = Database::insert(
                <<<'SQL'
                    INSERT INTO members
                      (full_name, email, phone, id_number, password_hash, status,
                       emergency_contact_name, emergency_contact_phone, joined_date)
                    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, CURDATE())
                    SQL,
                [
                    $fullName,
                    $email !== '' ? $email : null,
                    $storedPhone,
                    $idNumber !== '' ? $idNumber : null,
                    password_hash($password, PASSWORD_BCRYPT, ['cost' => self::BCRYPT_COST]),
                    !empty($body['emergency_contact_name'])
                        ? trim((string) $body['emergency_contact_name']) : null,
                    !empty($body['emergency_contact_phone'])
                        ? Phone::toMemberPhone($body['emergency_contact_phone']) : null,
                ]
            );

            Response::json([
                'success' => true,
                'member_id' => $id,
                'status' => 'pending',
                'message' => 'Registration received. An admin will review your application, '
                    . 'and you can log in once approved.',
            ], 201);
        } catch (\Throwable $e) {
            Log::warn('memberRegister: ' . $e->getMessage());
            Response::error('Registration failed. Please try again.', 500);
        }
    }

    public static function memberLogin(Request $r): void
    {
        $body = $r->body();
        $phone = $body['phone'] ?? null;
        $password = $body['password'] ?? null;

        if (!is_string($phone) || trim($phone) === '' || !is_string($password) || $password === '') {
            Response::error('Phone number and password are required.', 400);
        }

        /*
         * Members sign in with the number they know themselves by, and everyone
         * writes it differently: the phone contact says +254712345678, the till
         * receipt says 0712 345 678, and the app stores 0712345678. Comparing the
         * typed text to the stored column would lock out a member for the spelling
         * of their own number, so both sides are reduced to digits first.
         *
         * Scanned rather than queried, because the stored shape depends on when
         * the row was written - older rows predate this and can still hold
         * "+254..." - and SQL cannot compare two columns through a conversion.
         */
        $wanted = Phone::normalise($phone);
        $member = null;

        if ($wanted !== null) {
            foreach (Database::all('SELECT * FROM members') as $candidate) {
                if (Phone::normalise($candidate['phone']) === $wanted) {
                    $member = $candidate;
                    break;
                }
            }
        }

        if ($member === null) {
            password_verify($password, '$2y$12$usesomesillystringforsalt0123456789abcdefghijklmnopq');
            Response::error('Invalid phone number or password.', 401);
        }

        if (!password_verify($password, $member['password_hash'])) {
            Response::error('Invalid phone number or password.', 401);
        }

        if (($member['status'] ?? '') !== 'active') {
            Response::error(
                'Your account is not active. Please contact the admin.',
                403
            );
        }

        $token = Auth::issue([
            'id' => (int) $member['id'],
            'phone' => $member['phone'],
            'type' => 'member',
        ]);

        Database::run('UPDATE members SET last_login = NOW() WHERE id = ?', [$member['id']]);

        Response::json([
            'success' => true,
            'token' => $token,
            'member' => [
                'id' => (int) $member['id'],
                'type' => 'member',
                'full_name' => $member['full_name'],
                'email' => $member['email'],
                'phone' => $member['phone'],
                'status' => $member['status'],
            ],
        ]);
    }

    public static function adminProfile(Request $r, array $admin): void
    {
        Response::json([
            'admin' => [
                'id' => (int) $admin['id'],
                'member_id' => $admin['member_id'] !== null ? (int) $admin['member_id'] : null,
                'type' => 'admin',
                'full_name' => $admin['full_name'],
                'email' => $admin['email'],
                'phone' => $admin['phone'],
                'role_id' => (int) $admin['role_id'],
                'role' => $admin['role'],
                'last_login' => $admin['last_login'],
                /*
                 * Carried here as well as on the login response, because a page
                 * reload while the account is still flagged reads the profile
                 * rather than logging in again. Without it the flag would be
                 * forgotten on refresh and the app would open normally.
                 */
                'must_change_password' => !empty($admin['must_change_password']),
                'permissions' => $admin['permissions'] ?? [],
            ],
        ]);
    }

    public static function memberProfile(Request $r, array $member): void
    {
        Response::json([
            'member' => [
                'id' => (int) $member['id'],
                'type' => 'member',
                'full_name' => $member['full_name'],
                'email' => $member['email'],
                'phone' => $member['phone'],
                'status' => $member['status'],
                'language' => $member['language'] ?? null,
            ],
        ]);
    }

    /**
     * Exchanges a still-valid token for a fresh one.
     *
     * The frontend calls this in the background while somebody is working, so
     * that a session does not expire in the middle of a task. The route did not
     * exist in the port, so the request 404'd - and the caller swallows a failed
     * renewal on purpose, because a background request nobody asked for should
     * not end a session. So the symptom was never an error on screen: it was
     * sessions quietly running out on a long afternoon, which is the exact thing
     * the feature exists to prevent.
     *
     * Ported from refreshToken in backend/controllers/authController.js.
     *
     * The token is verified again rather than trusted, because the account it
     * names may have been deactivated since it was issued. A token that keeps
     * working after somebody has been removed is worse than one that expires.
     *
     * Deliberately unauthenticated, matching the Node route. The method reads
     * the header itself: running the usual guard first would answer a missing
     * token with "Access denied" rather than this endpoint's own words, and the
     * frontend distinguishes the two.
     */
    public static function refreshToken(Request $r): void
    {
        try {
            $token = $r->bearerToken();

            if ($token === null || $token === '') {
                Response::error('No token provided.', 401);
            }

            $claims = Auth::decode($token);

            if ($claims === null) {
                Response::error('Session expired. Please sign in again.', 401);
            }

            $isAdmin = ($claims['type'] ?? null) === 'admin';

            /*
             * The claims are carried across rather than rebuilt from the
             * database.
             *
             * Rebuilding looks tidier and would be wrong: impersonated_by is a
             * claim, not a column, so a renewal during an impersonated session
             * would drop it and silently return the super admin to their own
             * account - ending the session they were in the middle of.
             */
            $newToken = Auth::issue([
                'id' => $claims['id'] ?? null,
                'email' => $claims['email'] ?? null,
                'phone' => $claims['phone'] ?? null,
                'role' => $claims['role'] ?? null,
                'type' => $claims['type'] ?? null,
                'impersonated_by' => $claims['impersonated_by'] ?? null,
            ]);

            if ($isAdmin) {
                $admin = Database::one(
                    'SELECT id, member_id, full_name, email, phone, is_active FROM admins WHERE id = ?',
                    [$claims['id'] ?? null]
                );

                if ($admin === null || (int) $admin['is_active'] !== 1) {
                    Response::error('Account is deactivated.', 403);
                }

                Response::json(['token' => $newToken, 'type' => 'admin']);
            }

            $member = Database::one(
                'SELECT id, full_name, email, phone, status FROM members WHERE id = ?',
                [$claims['id'] ?? null]
            );

            if ($member === null || $member['status'] !== 'active') {
                Response::error('Account is not active.', 403);
            }

            Response::json(['token' => $newToken, 'type' => 'member']);
        } catch (\Throwable $e) {
            Log::warn('refreshToken: ' . $e->getMessage());
            Response::error('Could not refresh the session.', 500);
        }
    }

    public static function changePassword(Request $r, array $principal): void
    {
        $body = $r->body();
        $current = $body['current_password'] ?? null;
        $next = $body['new_password'] ?? null;
        $confirm = $body['confirm_password'] ?? null;

        if (!is_string($current) || !is_string($next)) {
            Response::error('Current and new password are required.', 400);
        }

        if (strlen($next) < 8) {
            Response::error('New password must be at least 8 characters.', 400);
        }

        // The confirm field is optional. The Node version only rejects when it is
        // actually present and different, because the admin form sends it and
        // the settings page does not.
        if ($confirm !== null && $confirm !== $next) {
            Response::error('The new passwords do not match.', 400);
        }

        $type = $principal['type'] ?? 'admin';

        if ($type === 'member') {
            $row = Database::one(
                'SELECT password_hash FROM members WHERE id = ?',
                [$principal['id']]
            );

            if ($row === null || !password_verify($current, $row['password_hash'])) {
                Response::error('Current password is incorrect.', 401);
            }

            if (hash_equals($next, $current)) {
                Response::error('The new password must be different from your current one.', 400);
            }

            Database::run(
                'UPDATE members SET password_hash = ? WHERE id = ?',
                [password_hash($next, PASSWORD_BCRYPT, ['cost' => self::BCRYPT_COST]), $principal['id']]
            );

            // Recorded so a password change can be explained in an audit later.
            self::audit($principal['id'], 'password_change', 'member', $principal['id'], ['via' => 'self']);

            Response::json([
                'success' => true,
                'message' => 'Password changed successfully.',
                'must_change_password' => false,
            ]);
        }

        // Administrator path: queries the admins table and clears the
        // first-sign-in flag in the same statement as the hash change.
        $row = Database::one(
            'SELECT password_hash FROM admins WHERE id = ?',
            [$principal['id']]
        );

        if ($row === null || !password_verify($current, $row['password_hash'])) {
            Response::error('Current password is incorrect.', 401);
        }

        /*
         * Reusing the current password is refused rather than accepted quietly.
         *
         * An account on the shared initial password is here precisely to replace
         * it; letting the same string through would clear the requirement while
         * leaving the account exactly as exposed as before, which would make the
         * whole first-sign-in step a screen that achieves nothing.
         */
        if (hash_equals($next, $current)) {
            Response::error('The new password must be different from your current one.', 400);
        }

        Database::run(
            /*
             * The flag is cleared in the same statement as the password change.
             * Two statements would leave a window - and a crash between them would
             * leave an account whose password is new but which is still refused
             * everywhere, which is indistinguishable from being locked out.
             */
            'UPDATE admins SET password_hash = ?, must_change_password = 0 WHERE id = ?',
            [password_hash($next, PASSWORD_BCRYPT, ['cost' => self::BCRYPT_COST]), $principal['id']]
        );

        // Recorded so a password change can be explained in an audit later.
        self::audit($principal['id'], 'password_change', 'admin', $principal['id'], ['via' => 'self']);

        Response::json([
            'success' => true,
            'message' => 'Password changed successfully.',
            'must_change_password' => false,
        ]);
    }

    /**
     * Who a super admin may open the portal as.
     *
     * Admins appear too, because an admin is also a member (migration 016) and
     * a super admin needs to see the member side of their own account.
     */
    public static function impersonationTargets(Request $r, array $admin): void
    {
        $members = Database::all(
            <<<'SQL'
                SELECT m.id, m.full_name, m.phone, m.status
                  FROM members m
                 WHERE m.status = 'active'
                 ORDER BY m.full_name
                SQL
        );

        $admins = Database::all(
            <<<'SQL'
                SELECT a.id, a.full_name, a.email, a.is_active, r.name AS role
                  FROM admins a
                  JOIN roles r ON a.role_id = r.id
                 ORDER BY a.full_name
                SQL
        );

        Response::json([
            'members' => array_map(static fn($m) => [
                'id' => (int) $m['id'],
                'full_name' => $m['full_name'],
                'phone' => $m['phone'],
                'status' => $m['status'],
            ], $members),
            'admins' => array_map(static fn($a) => [
                'id' => (int) $a['id'],
                'full_name' => $a['full_name'],
                'email' => $a['email'],
                'is_active' => (bool) $a['is_active'],
                'role' => $a['role'],
            ], $admins),
        ]);
    }

    /**
     * Opens the portal as somebody else.
     *
     * Returns two tokens: one for the target, and one to return to the super
     * admin's own session with. Without the second, exiting impersonation would
     * ask for a password again - and a super admin who got locked out this way
     * would have no way back in.
     */
    public static function impersonate(Request $r, array $admin): void
    {
        $body = $r->body();
        $targetType = $body['target_type'] ?? null;
        $targetId = (int) ($body['target_id'] ?? 0);

        if (!in_array($targetType, ['admin', 'member'], true) || $targetId <= 0) {
            Response::error('Choose somebody to open the portal as.', 400);
        }

        if ($targetType === 'admin' && $targetId === (int) $admin['id']) {
            Response::error('You are already signed in as yourself.', 400);
        }

        if ($targetType === 'member') {
            $target = Database::one(
                'SELECT id, full_name, email, phone, status FROM members WHERE id = ?',
                [$targetId]
            );
            if ($target === null) {
                Response::error('That member was not found.', 404);
            }
            $principal = [
                'id' => (int) $target['id'],
                'type' => 'member',
                'full_name' => $target['full_name'],
                'email' => $target['email'],
                'phone' => $target['phone'],
                'status' => $target['status'],
            ];
        } else {
            $target = Database::one(
                'SELECT a.id, a.full_name, a.email, a.phone, a.is_active, r.name AS role
                   FROM admins a JOIN roles r ON a.role_id = r.id
                  WHERE a.id = ?',
                [$targetId]
            );
            if ($target === null) {
                Response::error('That admin was not found.', 404);
            }
            $target['permissions'] = Auth::resolvePrincipal($targetId, 'admin')['permissions'];
            $principal = [
                'id' => (int) $target['id'],
                'type' => 'admin',
                'full_name' => $target['full_name'],
                'email' => $target['email'],
                'phone' => $target['phone'],
                'role' => $target['role'],
                'permissions' => $target['permissions'],
            ];
        }

        $token = Auth::issue(array_merge($principal, ['type' => $targetType, 'impersonated_by' => (int) $admin['id']]));
        $returnToken = Auth::issue([
            'id' => (int) $admin['id'],
            'email' => $admin['email'],
            'role' => $admin['role'],
            'type' => 'admin',
        ]);

        self::audit((int) $admin['id'], 'impersonate', $targetType, $targetId, []);

        Response::json([
            'success' => true,
            'token' => $token,
            'return_token' => $returnToken,
            'principal' => $principal,
            'impersonated_by' => [
                'id' => (int) $admin['id'],
                'full_name' => $admin['full_name'],
            ],
        ]);
    }

    /**
     * Writes an audit row.
     *
     * Best effort on purpose: an audit failure must not block the action the
     * user asked for, but it is logged so it is never silently lost.
     *
     * Ids arrive as strings from MySQL, so these are cast rather than typed as
     * int. Typing them would make every caller responsible for a cast, and the
     * one that is forgotten is a fatal error during a password change.
     */
    private static function audit($adminId, string $action, string $entity, $entityId, array $details): void
    {
        try {
            Database::run(
                'INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, details)
                 VALUES (?, ?, ?, ?, ?)',
                [$adminId, $action, $entity, $entityId, json_encode($details)]
            );
        } catch (\Throwable $e) {
            Log::warn('audit: could not record: ' . $e->getMessage());
        }
    }
}