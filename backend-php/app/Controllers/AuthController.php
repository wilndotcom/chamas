<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Auth;
use TheTeam\Database;
use TheTeam\Request;
use TheTeam\Response;

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
    /** Bcrypt cost. Matches the Node side's 12. */
    private const COST = 12;

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
                'permissions' => $principal['permissions'],
            ],
        ]);
    }

    public static function memberLogin(Request $r): void
    {
        $body = $r->body();
        $phone = $body['phone'] ?? null;
        $password = $body['password'] ?? null;

        if (!is_string($phone) || trim($phone) === '' || !is_string($password) || $password === '') {
            Response::error('Phone number and password are required.', 400);
        }

        $member = Database::one(
            'SELECT * FROM members WHERE phone = ? LIMIT 1',
            [trim($phone)]
        );

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

    public static function changePassword(Request $r, array $admin): void
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

        $row = Database::one(
            'SELECT password_hash FROM admins WHERE id = ?',
            [$admin['id']]
        );

        if ($row === null || !password_verify($current, $row['password_hash'])) {
            Response::error('Your current password is not correct.', 401);
        }

        Database::run(
            'UPDATE admins SET password_hash = ? WHERE id = ?',
            [password_hash($next, self::COST), $admin['id']]
        );

        // Recorded so a password change can be explained in an audit later.
        self::audit($admin['id'], 'password_change', 'admin', $admin['id'], ['via' => 'self']);

        Response::json(['success' => true, 'message' => 'Password updated']);
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
     */
    private static function audit(?int $adminId, string $action, string $entity, int $entityId, array $details): void
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