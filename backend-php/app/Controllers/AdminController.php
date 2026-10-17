<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Database;
use TheTeam\Log;
use TheTeam\Request;
use TheTeam\Response;

/**
 * Administrator accounts.
 *
 * A port of backend/controllers/adminController.js.
 *
 * An admin is also a member, so creating one creates both records together (see
 * createAdmin). That is not a convenience: without a member row an admin cannot
 * contribute, borrow, or appear in any member list, which is not how a chama
 * works - the chair and treasurer save like everyone else.
 */
final class AdminController
{
    /** Bcrypt work factor. Matches the Node side. */
    private const BCRYPT_COST = 12;

    /**
     * Every admin.
     *
     * member_id is included because admins are also members (migration 016). A
     * screen offering "record a welfare contribution" needs to know which member
     * record is the admin's own: without it the client has no way to offer them
     * as a choice, so an admin could only ever pay into the fund on somebody
     * else's behalf.
     */
    public static function getAllAdmins(Request $r): void
    {
        try {
            $admins = Database::all(
                <<<'SQL'
                    SELECT a.id, a.member_id, a.full_name, a.username, a.email, a.phone,
                           a.is_active, a.last_login, a.created_at, r.name AS role_name
                      FROM admins a JOIN roles r ON a.role_id = r.id
                     ORDER BY a.created_at DESC
                    SQL
            );

            Response::json(['admins' => $admins]);
        } catch (\Throwable $e) {
            Log::warn('getAllAdmins: ' . $e->getMessage());
            Response::error('Failed to fetch admins.', 500);
        }
    }

    /** Creates an admin, and their member record with them. */
    public static function createAdmin(Request $r): void
    {
        try {
            $body = $r->body();

            $fullName = $body['full_name'] ?? null;
            $email = $body['email'] ?? null;
            $password = $body['password'] ?? null;
            $roleId = $body['role_id'] ?? null;
            $phone = $body['phone'] ?? null;
            $username = $body['username'] ?? null;

            if (!$fullName || !$email || !$password || !$roleId) {
                Response::error('All fields are required.', 400);
            }

            // Usernames are optional; an admin without one signs in with their
            // email.
            $cleanUsername = null;

            if ($username !== null && trim((string) $username) !== '') {
                $cleanUsername = strtolower(trim((string) $username));

                if (preg_match('/^[a-z0-9._-]{3,50}$/', $cleanUsername) !== 1) {
                    Response::error(
                        'Username must be 3-50 characters, using letters, numbers, dot, dash or underscore.',
                        400
                    );
                }

                if (Database::one('SELECT id FROM admins WHERE username = ?', [$cleanUsername]) !== null) {
                    Response::error('That username is already taken.', 409);
                }
            }

            if (Database::one('SELECT id FROM admins WHERE email = ?', [$email]) !== null) {
                Response::error('Email already exists.', 409);
            }

            $hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => self::BCRYPT_COST]);

            $adminId = Database::transaction(function ($pdo) use (
                $fullName, $cleanUsername, $email, $phone, $hash, $roleId
            ) {
                $pdo->prepare(
                    /*
                     * Flagged for a first-sign-in change, because the password was
                     * chosen by whoever created the account rather than by the
                     * person who will use it. Until they replace it the account is
                     * a credential two people know.
                     */
                    'INSERT INTO admins (full_name, username, email, phone, password_hash, role_id, must_change_password)
                     VALUES (?, ?, ?, ?, ?, ?, 1)'
                )->execute([$fullName, $cleanUsername, $email, $phone ?: null, $hash, $roleId]);

                $id = (int) $pdo->lastInsertId();

                /*
                 * Phone and email are only claimed when no member already holds
                 * them, because both are UNIQUE and a real member may well have
                 * registered with the same number the admin uses. When they
                 * collide the member row is still created with a generated
                 * number, so the link is never missing - and the admin simply
                 * will not be offered as a M-Pesa payee.
                 */
                $phoneTaken = $phone
                    ? self::countWhere($pdo, 'SELECT id FROM members WHERE phone = ?', [$phone]) > 0
                    : true;

                $emailTaken = self::countWhere($pdo, 'SELECT id FROM members WHERE email = ?', [$email]) > 0;

                // 9000000000-style number: valid length, no collision with a real
                // Kenyan number, and obviously synthetic if it ever surfaces.
                $memberPhone = $phoneTaken
                    ? '9000000' . str_pad((string) $id, 4, '0', STR_PAD_LEFT)
                    : $phone;

                $pdo->prepare(
                    <<<'SQL'
                        INSERT INTO members (full_name, email, phone, password_hash, status, joined_date)
                        VALUES (?, ?, ?, ?, 'active', CURDATE())
                        SQL
                )->execute([$fullName, $emailTaken ? null : $email, $memberPhone, $hash]);

                $memberId = (int) $pdo->lastInsertId();

                $pdo->prepare('UPDATE admins SET member_id = ? WHERE id = ?')->execute([$memberId, $id]);

                return $id;
            });

            Response::json([
                'success' => true,
                'admin_id' => $adminId,
                'message' => 'Admin created successfully.',
            ], 201);
        } catch (\Throwable $e) {
            Log::warn('createAdmin: ' . $e->getMessage());
            Response::error('Failed to create admin.', 500);
        }
    }

    /** Updates an admin. */
    public static function updateAdmin(Request $r): void
    {
        try {
            $id = $r->param('id');
            $body = $r->body();
            $username = $body['username'] ?? null;

            // An omitted or blank username clears it, which puts that admin back
            // on email-only sign-in rather than leaving a stale value behind.
            $nextUsername = null;

            if ($username !== null && trim((string) $username) !== '') {
                $nextUsername = strtolower(trim((string) $username));

                if (preg_match('/^[a-z0-9._-]{3,50}$/', $nextUsername) !== 1) {
                    Response::error(
                        'Username must be 3-50 characters, using letters, numbers, dot, dash or underscore.',
                        400
                    );
                }

                $taken = Database::one(
                    'SELECT id FROM admins WHERE username = ? AND id <> ?',
                    [$nextUsername, $id]
                );

                if ($taken !== null) {
                    Response::error('That username is already taken.', 409);
                }
            }

            Database::run(
                'UPDATE admins
                    SET full_name = ?, username = ?, email = ?, phone = ?, role_id = ?, is_active = ?
                  WHERE id = ?',
                [
                    $body['full_name'] ?? null,
                    $nextUsername,
                    $body['email'] ?? null,
                    $body['phone'] ?? null,
                    $body['role_id'] ?? null,
                    $body['is_active'] ?? null,
                    $id,
                ]
            );

            Response::json(['success' => true, 'message' => 'Admin updated successfully.']);
        } catch (\Throwable $e) {
            Log::warn('updateAdmin: ' . $e->getMessage());
            Response::error('Failed to update admin.', 500);
        }
    }

    /**
     * Deletes an admin.
     *
     * The member record is deliberately kept. An admin who is also a member may
     * have savings and loan history, and deleting that would rewrite the group's
     * past reports - the same protection members get.
     */
    public static function deleteAdmin(Request $r): void
    {
        try {
            $id = $r->param('id');

            // Prevent self-deletion.
            if ((int) $id === (int) $r->user['id']) {
                Response::error('You cannot delete your own account.', 400);
            }

            Database::run('DELETE FROM admins WHERE id = ?', [$id]);

            Response::json(['success' => true, 'message' => 'Admin deleted successfully.']);
        } catch (\Throwable $e) {
            Log::warn('deleteAdmin: ' . $e->getMessage());
            Response::error('Failed to delete admin.', 500);
        }
    }

    /** Every role. Also used to populate the role picker on the admin form. */
    public static function getRoles(Request $r): void
    {
        try {
            $roles = Database::all('SELECT * FROM roles ORDER BY id');
            Response::json(['roles' => $roles]);
        } catch (\Throwable $e) {
            Log::warn('getRoles: ' . $e->getMessage());
            Response::error('Failed to fetch roles.', 500);
        }
    }

    /** The most recent audit entries. */
    public static function getAuditLogs(Request $r): void
    {
        try {
            $logs = Database::all(
                <<<'SQL'
                    SELECT al.*, a.full_name AS admin_name, m.full_name AS member_name
                      FROM audit_logs al
                      LEFT JOIN admins a ON al.admin_id = a.id
                      LEFT JOIN members m ON al.member_id = m.id
                     ORDER BY al.created_at DESC LIMIT 100
                    SQL
            );

            Response::json(['logs' => $logs]);
        } catch (\Throwable $e) {
            Log::warn('getAuditLogs: ' . $e->getMessage());
            Response::error('Failed to fetch audit logs.', 500);
        }
    }

    /** Counts matching rows on a connection already inside a transaction. */
    private static function countWhere(\PDO $pdo, string $sql, array $params): int
    {
        $statement = $pdo->prepare($sql);
        $statement->execute($params);

        return count($statement->fetchAll(\PDO::FETCH_COLUMN));
    }
}