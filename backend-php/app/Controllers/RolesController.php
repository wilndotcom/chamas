<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Database;
use TheTeam\Log;
use TheTeam\Request;
use TheTeam\Response;

/**
 * Roles and per-admin permission overrides.
 *
 * A port of backend/controllers/rolesController.js.
 *
 * Two rules protect the system from being locked out of its own repair controls,
 * and both are enforced here rather than in the UI, because the UI is not what
 * stops a determined or careless caller:
 *
 *   The super admin role always keeps every permission. Removing one would mean
 *   nobody could ever put it back.
 *
 *   The super admin cannot have per-admin overrides applied, since overrides only
 *   ever narrow what a role already grants.
 */
final class RolesController
{
    /** Roles, with their permissions and how many admins hold each. */
    public static function getRoles(Request $r): void
    {
        try {
            $roles = Database::all(
                <<<'SQL'
                    SELECT r.id, r.name, r.description, r.is_system,
                           (SELECT COUNT(*) FROM admins a WHERE a.role_id = r.id) AS admin_count
                      FROM roles r ORDER BY r.is_system DESC, r.id
                    SQL
            );

            $links = Database::all(
                'SELECT rp.role_id, p.name
                   FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id'
            );

            $permissions = Database::all(
                'SELECT id, name, description, category FROM permissions ORDER BY category, name'
            );

            $byRole = [];
            foreach ($links as $link) {
                $byRole[(string) $link['role_id']][] = $link['name'];
            }

            Response::json([
                'roles' => array_map(static function (array $role) use ($byRole): array {
                    $role['permissions'] = $byRole[(string) $role['id']] ?? [];
                    // Tells the UI to show it as locked. The server refuses
                    // regardless.
                    $role['locked'] = $role['name'] === 'super_admin';
                    return $role;
                }, $roles),
                'permissions' => $permissions,
            ]);
        } catch (\Throwable $e) {
            Log::warn('getRoles: ' . $e->getMessage());
            Response::error('Failed to load roles.', 500);
        }
    }

    /** Replaces the permission set of a role. */
    public static function setRolePermissions(Request $r): void
    {
        try {
            $id = $r->param('id');
            $permissions = $r->body()['permissions'] ?? null;

            if (!is_array($permissions) || !array_is_list($permissions)) {
                Response::error('permissions must be an array of names.', 400);
            }

            $role = Database::one('SELECT id, name, is_system FROM roles WHERE id = ?', [$id]);

            if ($role === null) {
                Response::error('Role not found.', 404);
            }

            // The super admin must keep every permission, otherwise nobody could
            // ever restore them and the system would be permanently locked.
            if ($role['name'] === 'super_admin') {
                $all = Database::all('SELECT id FROM permissions');

                Database::transaction(function ($pdo) use ($id, $all): void {
                    $pdo->prepare('DELETE FROM role_permissions WHERE role_id = ?')->execute([$id]);

                    foreach ($all as $permission) {
                        $pdo->prepare(
                            'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)'
                        )->execute([$id, $permission['id']]);
                    }
                });

                self::audit($r, 'super_admin_permissions_reset', ['role_id' => $id]);

                Response::json([
                    'success' => true,
                    'message' => 'Super admin always keeps every permission.',
                ]);
            }

            if ($permissions === []) {
                Response::error(
                    'A role needs at least one permission, otherwise nobody using it can do anything.',
                    400
                );
            }

            $placeholders = implode(',', array_fill(0, count($permissions), '?'));

            $valid = Database::all(
                "SELECT id, name FROM permissions WHERE name IN ({$placeholders})",
                $permissions
            );

            if (count($valid) !== count($permissions)) {
                $known = array_column($valid, 'name');
                $unknown = array_values(array_filter(
                    $permissions,
                    static fn($p) => !in_array($p, $known, true)
                ));

                Response::error('Unknown permission(s): ' . implode(', ', $unknown), 400);
            }

            // Delete and insert together: a role with neither the old set nor the
            // new one would lock out everyone holding it.
            Database::transaction(function ($pdo) use ($id, $valid): void {
                $pdo->prepare('DELETE FROM role_permissions WHERE role_id = ?')->execute([$id]);

                foreach ($valid as $permission) {
                    $pdo->prepare(
                        'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)'
                    )->execute([$id, $permission['id']]);
                }
            });

            self::audit($r, 'role_permissions_updated', [
                'role' => $role['name'],
                'permissions' => $permissions,
            ]);

            Response::json([
                'success' => true,
                'message' => sprintf('%s now has %d permission(s).', $role['name'], count($valid)),
                'permissions' => array_column($valid, 'name'),
            ]);
        } catch (\Throwable $e) {
            Log::warn('setRolePermissions: ' . $e->getMessage());
            Response::error('Failed to update the role.', 500);
        }
    }

    /** Creates a custom role. */
    public static function createRole(Request $r): void
    {
        try {
            $body = $r->body();
            $permissions = $body['permissions'] ?? null;

            $cleanName = strtolower(trim((string) ($body['name'] ?? '')));
            $cleanName = (string) preg_replace('/\s+/', '_', $cleanName);

            if ($cleanName === '') {
                Response::error('Role name is required.', 400);
            }

            if (preg_match('/^[a-z][a-z0-9_]{2,39}$/', $cleanName) !== 1) {
                Response::error(
                    'Use 3-40 characters: lowercase letters, numbers and underscores.',
                    400
                );
            }

            if (!is_array($permissions) || $permissions === []) {
                Response::error('Pick at least one permission.', 400);
            }

            if (Database::one('SELECT id FROM roles WHERE name = ?', [$cleanName]) !== null) {
                Response::error('A role with that name already exists.', 409);
            }

            $placeholders = implode(',', array_fill(0, count($permissions), '?'));

            $valid = Database::all(
                "SELECT id, name FROM permissions WHERE name IN ({$placeholders})",
                $permissions
            );

            $description = $body['description'] ?? ("Custom role: {$cleanName}");

            $roleId = Database::transaction(function ($pdo) use (
                $cleanName, $description, $valid
            ) {
                $pdo->prepare(
                    'INSERT INTO roles (name, description, is_system) VALUES (?, ?, 0)'
                )->execute([$cleanName, $description]);

                $id = (int) $pdo->lastInsertId();

                foreach ($valid as $permission) {
                    $pdo->prepare(
                        'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)'
                    )->execute([$id, $permission['id']]);
                }

                return $id;
            });

            self::audit($r, 'role_created', [
                'name' => $cleanName,
                'permissions' => array_column($valid, 'name'),
            ]);

            Response::json([
                'success' => true,
                'role_id' => $roleId,
                'role' => [
                    'id' => $roleId,
                    'name' => $cleanName,
                    'description' => $body['description'] ?? null,
                    'is_system' => 0,
                ],
                'message' => sprintf('Role "%s" created.', $cleanName),
            ], 201);
        } catch (\Throwable $e) {
            Log::warn('createRole: ' . $e->getMessage());
            Response::error('Failed to create the role.', 500);
        }
    }

    /** Renames or re-describes a custom role. */
    public static function updateRole(Request $r): void
    {
        try {
            $id = $r->param('id');
            $body = $r->body();

            $role = Database::one('SELECT id, name, is_system FROM roles WHERE id = ?', [$id]);

            if ($role === null) {
                Response::error('Role not found.', 404);
            }

            if ((bool) $role['is_system']) {
                // Renaming super_admin would break every permission check that
                // compares against that literal name.
                Response::error(
                    'Built-in roles cannot be renamed. Permissions can still be changed.',
                    400
                );
            }

            $cleanName = strtolower(trim((string) ($body['name'] ?? '')));
            $cleanName = (string) preg_replace('/\s+/', '_', $cleanName);

            if (preg_match('/^[a-z][a-z0-9_]{2,39}$/', $cleanName) !== 1) {
                Response::error(
                    'Use 3-40 characters: lowercase letters, numbers and underscores.',
                    400
                );
            }

            $clash = Database::one(
                'SELECT id FROM roles WHERE name = ? AND id <> ?',
                [$cleanName, $id]
            );

            if ($clash !== null) {
                Response::error('A role with that name already exists.', 409);
            }

            Database::run(
                'UPDATE roles SET name = ?, description = ? WHERE id = ?',
                [$cleanName, $body['description'] ?? null, $id]
            );

            self::audit($r, 'role_updated', ['role_id' => (int) $id, 'name' => $cleanName]);

            Response::json(['success' => true, 'message' => 'Role updated.']);
        } catch (\Throwable $e) {
            Log::warn('updateRole: ' . $e->getMessage());
            Response::error('Failed to update the role.', 500);
        }
    }

    /** Deletes a custom role that nobody holds. */
    public static function deleteRole(Request $r): void
    {
        try {
            $id = $r->param('id');

            $role = Database::one('SELECT id, name, is_system FROM roles WHERE id = ?', [$id]);

            if ($role === null) {
                Response::error('Role not found.', 404);
            }

            if ((bool) $role['is_system']) {
                Response::error('Built-in roles cannot be deleted.', 400);
            }

            $inUse = (int) Database::scalar(
                'SELECT COUNT(*) FROM admins WHERE role_id = ?',
                [$id]
            );

            if ($inUse > 0) {
                // Refused rather than cascading: deleting a role would leave
                // every admin holding it with no role at all.
                Response::error(sprintf(
                    '%d admin(s) still use this role. Reassign them first.',
                    $inUse
                ), 400);
            }

            Database::transaction(function ($pdo) use ($id): void {
                $pdo->prepare('DELETE FROM role_permissions WHERE role_id = ?')->execute([$id]);
                $pdo->prepare('DELETE FROM roles WHERE id = ?')->execute([$id]);
            });

            self::audit($r, 'role_deleted', ['role' => $role['name']]);

            Response::json([
                'success' => true,
                'message' => sprintf('Role "%s" deleted.', $role['name']),
            ]);
        } catch (\Throwable $e) {
            Log::warn('deleteRole: ' . $e->getMessage());
            Response::error('Failed to delete the role.', 500);
        }
    }

    // ------------------------------------------------- per-admin overrides

    /** One admin's role permissions and the overrides applied on top. */
    public static function getAdminOverrides(Request $r): void
    {
        try {
            $id = $r->param('adminId');

            $admin = Database::one(
                <<<'SQL'
                    SELECT a.id, a.full_name, a.email, a.role_id, r.name AS role_name
                      FROM admins a JOIN roles r ON a.role_id = r.id
                     WHERE a.id = ?
                    SQL,
                [$id]
            );

            if ($admin === null) {
                Response::error('Admin not found.', 404);
            }

            $overrides = Database::all(
                <<<'SQL'
                    SELECT p.name, o.mode
                      FROM admin_permission_overrides o
                      JOIN permissions p ON p.id = o.permission_id
                     WHERE o.admin_id = ?
                    SQL,
                [$id]
            );

            $rolePermissions = Database::all(
                <<<'SQL'
                    SELECT p.name
                      FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
                     WHERE rp.role_id = ?
                    SQL,
                [$admin['role_id']]
            );

            $permissions = Database::all(
                'SELECT id, name, description, category FROM permissions ORDER BY category, name'
            );

            Response::json([
                'admin' => array_merge($admin, [
                    'is_super_admin' => $admin['role_name'] === 'super_admin',
                ]),
                'role_permissions' => array_column($rolePermissions, 'name'),
                'overrides' => array_map(static fn($o) => [
                    'name' => $o['name'],
                    'mode' => $o['mode'],
                ], $overrides),
                'permissions' => $permissions,
            ]);
        } catch (\Throwable $e) {
            Log::warn('getAdminOverrides: ' . $e->getMessage());
            Response::error('Failed to load admin permissions.', 500);
        }
    }

    /**
     * Replaces one admin's overrides.
     *
     * A grant adds a permission their role lacks; a revoke removes one it has.
     * An empty list clears them.
     */
    public static function setAdminOverrides(Request $r): void
    {
        try {
            $id = $r->param('adminId');
            $overrides = $r->body()['overrides'] ?? null;

            if (!is_array($overrides) || !array_is_list($overrides)) {
                Response::error('overrides must be an array.', 400);
            }

            $admin = Database::one(
                'SELECT a.id, a.full_name, r.name AS role_name
                   FROM admins a JOIN roles r ON a.role_id = r.id
                  WHERE a.id = ?',
                [$id]
            );

            if ($admin === null) {
                Response::error('Admin not found.', 404);
            }

            if ($admin['role_name'] === 'super_admin') {
                Response::error(
                    'The super admin keeps every permission and cannot be restricted.',
                    400
                );
            }

            foreach ($overrides as $override) {
                $mode = is_array($override) ? ($override['mode'] ?? null) : null;

                if (!in_array($mode, ['grant', 'revoke'], true)) {
                    Response::error('Each override needs mode "grant" or "revoke".', 400);
                }
            }

            // Names are looked up so a typo cannot store an override pointing at
            // a permission id that does not exist.
            $names = array_values(array_filter(array_map(
                static fn($o) => is_array($o) ? ($o['name'] ?? null) : null,
                $overrides
            )));

            $rows = [];

            if ($names !== []) {
                $placeholders = implode(',', array_fill(0, count($names), '?'));

                $valid = Database::all(
                    "SELECT id, name FROM permissions WHERE name IN ({$placeholders})",
                    $names
                );

                foreach ($valid as $permission) {
                    foreach ($overrides as $override) {
                        if (($override['name'] ?? null) === $permission['name']) {
                            $rows[] = [$id, $permission['id'], $override['mode']];
                        }
                    }
                }
            }

            Database::transaction(function ($pdo) use ($id, $rows): void {
                $pdo->prepare('DELETE FROM admin_permission_overrides WHERE admin_id = ?')
                    ->execute([$id]);

                foreach ($rows as $row) {
                    $pdo->prepare(
                        'INSERT INTO admin_permission_overrides (admin_id, permission_id, mode)
                         VALUES (?, ?, ?)'
                    )->execute($row);
                }
            });

            self::audit($r, 'admin_permissions_updated', [
                'admin' => $admin['full_name'],
                'overrides' => array_map(
                    static fn($o) => $o['mode'] . ':' . ($o['name'] ?? '?'),
                    $overrides
                ),
            ]);

            Response::json([
                'success' => true,
                'message' => sprintf('Custom rights saved for %s.', $admin['full_name']),
                'overrides' => count($overrides),
            ]);
        } catch (\Throwable $e) {
            Log::warn('setAdminOverrides: ' . $e->getMessage());
            Response::error('Failed to save the admin permissions.', 500);
        }
    }

    /**
     * Writes an audit row.
     *
     * Permission changes are the ones an operator may need to explain afterwards,
     * so this is recorded on every one. Best effort: an audit failure must not
     * block the change itself, but it is logged rather than silently lost.
     */
    private static function audit(Request $r, string $action, array $details): void
    {
        try {
            Database::run(
                'INSERT INTO audit_logs (admin_id, action, details, ip_address) VALUES (?, ?, ?, ?)',
                [$r->user['id'], $action, json_encode($details), $r->ip()]
            );
        } catch (\Throwable $e) {
            Log::warn('audit: could not record: ' . $e->getMessage());
        }
    }
}