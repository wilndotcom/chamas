<?php

declare(strict_types=1);

namespace TheTeam;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;

/**
 * Tokens and permissions.
 *
 * The tokens produced here are the same shape as the Node version's: HS256 over
 * {id, email, phone, role, type, iat, exp}. That matters more than it looks -
 * an existing session must keep working across the switch, or every signed-in
 * user is logged out at the worst possible moment.
 *
 * The permission rule is the same too, including the super admin bypass. That
 * bypass is why `role` has to survive in the token: an admin whose role changed
 * keeps the old permissions until the token expires, which is a known and
 * accepted trade for stateless tokens rather than something to fix here.
 */
final class Auth
{
    private const TYPE_ADMIN = 'admin';
    private const TYPE_MEMBER = 'member';

    /** The one role that bypasses both permission checks and override filtering. */
    private const ROLE_SUPER_ADMIN = 'super_admin';

    /** Verifies a token and returns its payload. */
    public static function decode(string $token): ?array
    {
        try {
            $secret = Env::get('JWT_SECRET');
            if ($secret === null || $secret === '') {
                return null;
            }
            $decoded = JWT::decode($token, new Key($secret, 'HS256'));
            return (array) $decoded;
        } catch (\Throwable) {
            // Covers an expired token, a bad signature and a malformed one. They
            // are all the same answer to the caller: not a valid session.
            return null;
        }
    }

    /** Issues a token with the same claim shape as the Node version. */
    public static function issue(array $claims): string
    {
        $secret = Env::get('JWT_SECRET');
        if ($secret === null || $secret === '') {
            throw new \RuntimeException('JWT_SECRET is not set.');
        }

        $now = time();
        $expiresIn = Env::get('JWT_EXPIRES_IN', '24h');

        return JWT::encode(
            array_merge($claims, [
                'iat' => $now,
                'exp' => $now + self::secondsFrom($expiresIn),
            ]),
            $secret,
            'HS256'
        );
    }

    /**
     * Turns a duration such as '24h' or '7d' into seconds.
     *
     * Written out rather than relying on strtotime, because strtotime's return
     * depends on the current date and on the system timezone. A token that
     * silently expired at a different length on another machine is exactly the
     * sort of difference between the two ports that would go unnoticed.
     */
    public static function secondsFrom(string $value): int
    {
        $value = trim($value);
        if ($value === '') {
            return 86400;
        }

        if (preg_match('/^(\d+)\s*([smhd]?)$/i', $value, $m) === 1) {
            $amount = (int) $m[1];
            $unit = strtolower($m[2] ?: 's');
            return match ($unit) {
                's' => $amount,
                'm' => $amount * 60,
                'h' => $amount * 3600,
                'd' => $amount * 86400,
                default => $amount,
            };
        }

        $parsed = strtotime($value);
        return $parsed === false ? 86400 : max(1, $parsed - time());
    }

    /**
     * Requires a valid token of the given type, or answers and stops.
     *
     * `verifyToken` in the Node middleware, including its behaviour of rejecting
     * a token of the wrong type outright: a member token must not open an admin
     * route just because it is otherwise valid.
     */
    public static function require(Request $request, string $expectedType = self::TYPE_ADMIN): array
    {
        $token = $request->bearerToken();
        if ($token === null) {
            Response::error('Access denied. No token provided.', 401);
        }

        $claims = self::decode($token);
        if ($claims === null) {
            // One message for every reason, so a caller cannot tell a wrong
            // signature from an expired token and use that to probe.
            Response::error('Access denied. Invalid or expired token.', 401);
        }

        $type = $claims['type'] ?? '';
        if ($type !== $expectedType) {
            Response::error("This endpoint requires a {$expectedType} token.", 403);
        }

        // The account is re-read rather than trusted from the token, so a
        // deactivated admin loses access immediately instead of at token expiry.
        $principal = self::resolvePrincipal((int) ($claims['id'] ?? 0), $type);
        if ($principal === null) {
            Response::error('Invalid token.', 401);
        }

        // Separate check from resolution, because the two failures mean
        // different things to the person affected: a missing account is a bad
        // token, a suspended one is a working token for somebody who is no
        // longer allowed in. Collapsing them would log an innocent user out.
        if ($type === self::TYPE_ADMIN) {
            if (empty($principal['is_active'])) {
                Response::error('Account is deactivated.', 403);
            }
        } elseif (($principal['status'] ?? '') !== 'active') {
            Response::error('Account is not active.', 403);
        }

        $principal['impersonated'] = !empty($claims['impersonated_by']);
        $principal['claims'] = $claims;

        $request->user = $principal;
        return $principal;
    }

    /** Requires a member token. */
    public static function requireMember(Request $request): array
    {
        return self::require($request, self::TYPE_MEMBER);
    }

    /** Requires a super admin, for impersonation and role management. */
    public static function requireSuperAdmin(Request $request): array
    {
        $principal = self::require($request, self::TYPE_ADMIN);
        if (($principal['role'] ?? '') !== self::ROLE_SUPER_ADMIN) {
            Response::error('Access denied. Super admin only.', 403);
        }
        return $principal;
    }

    /**
     * Requires one of the given permissions.
     *
     * Super admin passes everything, matching authorize() in the Node version.
     * The error body carries the same fields the React frontend reads to explain
     * the refusal.
     */
    public static function authorize(Request $request, array $required): void
    {
        $principal = $request->user;
        if ($principal === null) {
            Response::error('Not authenticated.', 401);
        }

        if (($principal['role'] ?? '') === self::ROLE_SUPER_ADMIN) {
            return;
        }

        $held = $principal['permissions'] ?? [];
        foreach ($required as $permission) {
            if (in_array($permission, $held, true)) {
                return;
            }
        }

        Response::error('Access denied. Insufficient permissions.', 403, [
            'required' => $required,
            'your_permissions' => array_values($held),
        ]);
    }

    public static function hasPermission(?array $user, string $permission): bool
    {
        if ($user === null || ($user['type'] ?? '') !== self::TYPE_ADMIN) {
            return false;
        }
        if (($user['role'] ?? '') === self::ROLE_SUPER_ADMIN) {
            return true;
        }
        return in_array($permission, $user['permissions'] ?? [], true);
    }

    /**
     * The signed-in account, with its permissions resolved.
     *
     * Shared by login, impersonation and require() so that all three report the
     * same permissions for the same person. When these drift apart the symptom
     * is a menu that offers a button the API then refuses, which reads as a
     * permissions bug rather than a code duplication bug.
     *
     * Returns null when there is no such account. It deliberately does not
     * reject a deactivated account: resolution and refusal are separate, so the
     * caller can choose the status code.
     */
    public static function resolvePrincipal(int $id, string $type): ?array
    {
        $principal = self::loadPrincipal($type, $id);
        if ($principal === null) {
            return null;
        }

        $principal['type'] = $type;
        if ($type === self::TYPE_ADMIN) {
            $principal['permissions'] = self::permissionsFor($principal);
        }

        return $principal;
    }

    /** The raw row, without permissions. */
    private static function loadPrincipal(string $type, int $id): ?array
    {
        if ($id <= 0) {
            return null;
        }

        if ($type === self::TYPE_ADMIN) {
            return Database::one(
                <<<'SQL'
                    SELECT a.id, a.member_id, a.full_name, a.email, a.phone, a.role_id,
                           a.is_active, r.name AS role
                      FROM admins a
                      JOIN roles r ON a.role_id = r.id
                     WHERE a.id = ?
                    SQL,
                [$id]
            );
        }

        return Database::one(
            'SELECT id, full_name, email, phone, status FROM members WHERE id = ?',
            [$id]
        );
    }

    /**
     * Role permissions plus any per-admin overrides.
     *
     * `grant` adds a permission the role lacks, `revoke` removes one it has.
     * Super admin is never filtered, so the system cannot be locked out of its
     * own repair controls - which is the one override that must not apply.
     *
     * A failure to read overrides is swallowed deliberately: overrides are an
     * enhancement, and refusing to load them would strip an admin of the
     * permissions their role already grants and lock them out over a transient
     * database error.
     */
    private static function permissionsFor(array $admin): array
    {
        $effective = array_column(
            Database::all(
                <<<'SQL'
                    SELECT p.name FROM permissions p
                      JOIN role_permissions rp ON p.id = rp.permission_id
                     WHERE rp.role_id = ?
                    SQL,
                [$admin['role_id']]
            ),
            'name'
        );

        if (($admin['role'] ?? '') === self::ROLE_SUPER_ADMIN) {
            return $effective;
        }

        try {
            $overrides = Database::all(
                <<<'SQL'
                    SELECT p.name, o.mode
                      FROM admin_permission_overrides o
                      JOIN permissions p ON p.id = o.permission_id
                     WHERE o.admin_id = ?
                    SQL,
                [$admin['id']]
            );
        } catch (\Throwable $e) {
            Log::warn('failed to load permission overrides: ' . $e->getMessage());
            return $effective;
        }

        foreach ($overrides as $override) {
            if (($override['mode'] ?? '') === 'grant') {
                if (!in_array($override['name'], $effective, true)) {
                    $effective[] = $override['name'];
                }
                continue;
            }
            // Anything that is not an explicit grant is a revoke. Treating an
            // unrecognised mode as a removal is the safe direction: an override
            // we cannot understand should take permissions away, not add them.
            $effective = array_values(array_filter(
                $effective,
                static fn($name) => $name !== $override['name']
            ));
        }

        return $effective;
    }
}