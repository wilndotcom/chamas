<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use PDOException;
use TheTeam\Database;
use TheTeam\Log;
use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Utils\LoanMath;

/**
 * Members, their financial history and their registrations.
 *
 * A port of backend/controllers/memberController.js. The response shapes, status
 * codes and error strings are reproduced exactly: the React frontend branches on
 * them, and a "helpful" reword would break the members screen with no obvious
 * cause.
 *
 * The rule that shapes most of this file is that a member's financial history is
 * never destroyed. Contributions are trust money and loan balances are
 * receivables, so deleting through them would silently rewrite every past report
 * and could erase a debt still owed. Deletion is refused and deactivation offered
 * instead, which stops somebody signing in while keeping the record intact.
 */
final class MemberController
{
    /** Bcrypt cost. Matches the Node side. */
    /**
     * Bcrypt work factor.
     *
     * A cost, not an algorithm. Passed as password_hash()'s third argument;
     * passing it as the second asks for an algorithm called "12" and fails.
     * Matches the Node side, so a member's existing password keeps working
     * whichever backend answers.
     */
    private const BCRYPT_COST = 12;

    /**
     * Tables whose rows carry financial or audit meaning for a member.
     *
     * These are why a member with history cannot simply be deleted.
     *
     * `notifications` is deliberately absent: it holds no money, so it is
     * cleared automatically on delete rather than blocking the operation.
     */
    private const HISTORY_TABLES = [
        ['table' => 'contributions', 'label' => 'contribution', 'plural' => 'contributions'],
        ['table' => 'loans', 'label' => 'loan', 'plural' => 'loans'],
        ['table' => 'loan_repayments', 'label' => 'loan repayment', 'plural' => 'loan repayments'],
        ['table' => 'welfare_contributions', 'label' => 'welfare contribution', 'plural' => 'welfare contributions'],
        ['table' => 'welfare_requests', 'label' => 'welfare request', 'plural' => 'welfare requests'],
        ['table' => 'ledger_entries', 'label' => 'ledger entry', 'plural' => 'ledger entries'],
        ['table' => 'audit_logs', 'label' => 'audit log entry', 'plural' => 'audit log entries'],
    ];

    // ---------------------------------------------------------------- reads

    /** Every member, with the totals the members screen shows. */
    public static function getAllMembers(Request $r): void
    {
        try {
            $members = Database::all(
                <<<'SQL'
                    SELECT m.*,
                      (SELECT COALESCE(SUM(amount), 0) FROM contributions
                        WHERE member_id = m.id AND status = 'confirmed') AS total_contributions,
                      (SELECT COALESCE(SUM(balance), 0) FROM loans
                        WHERE member_id = m.id AND status IN ('active', 'disbursed')) AS loan_balance
                      FROM members m
                     ORDER BY m.created_at DESC
                    SQL
            );

            // Told up front which members are protected by history, so the UI can
            // explain it rather than letting the admin hit an error on delete.
            $history = self::countHistoryFor(array_column($members, 'id'));

            $withHistory = array_map(static function (array $m) use ($history): array {
                $counts = $history[(string) $m['id']] ?? [];
                $blockers = self::describeBlockers($counts);

                $m['history_counts'] = (object) $counts;
                $m['history_blockers'] = $blockers;
                $m['can_delete'] = $blockers === [];

                return $m;
            }, $members);

            // The history map is keyed by member id, so it is forced to an object:
            // an empty array would encode as [] and the frontend would read
            // object keys off an array.
            Response::json(['members' => $withHistory]);
        } catch (\Throwable $e) {
            Log::warn('getAllMembers: ' . $e->getMessage());
            Response::error('Failed to fetch members.', 500);
        }
    }

    /** One member, with their recent contributions and loans. */
    public static function getMember(Request $r): void
    {
        try {
            $id = $r->param('id');

            $member = Database::one('SELECT * FROM members WHERE id = ?', [$id]);

            if ($member === null) {
                Response::error('Member not found.', 404);
            }

            $contributions = Database::all(
                'SELECT * FROM contributions WHERE member_id = ? ORDER BY contribution_date DESC LIMIT 10',
                [$id]
            );

            $loans = Database::all(
                'SELECT * FROM loans WHERE member_id = ? ORDER BY application_date DESC LIMIT 10',
                [$id]
            );

            Response::json(['member' => $member, 'contributions' => $contributions, 'loans' => $loans]);
        } catch (\Throwable $e) {
            Log::warn('getMember: ' . $e->getMessage());
            Response::error('Failed to fetch member.', 500);
        }
    }

    /**
     * A member's own dashboard.
     *
     * The member id comes from the token, never from the request. Accepting one
     * from the client would let any member read any other member's balances.
     */
    public static function getMemberDashboard(Request $r): void
    {
        try {
            $memberId = $r->user['id'];

            $member = Database::one('SELECT * FROM members WHERE id = ?', [$memberId]);

            $contributions = Database::scalar(
                <<<'SQL'
                    SELECT COALESCE(SUM(amount), 0) FROM contributions
                     WHERE member_id = ? AND status = 'confirmed'
                    SQL,
                [$memberId]
            );

            $loanTotals = Database::scalar(
                <<<'SQL'
                    SELECT COALESCE(SUM(balance), 0) FROM loans
                     WHERE member_id = ? AND status IN ('active', 'disbursed')
                    SQL,
                [$memberId]
            );

            // Full application history, so the member can see what they applied
            // for and where it stands rather than only a balance figure.
            $applications = Database::all(
                <<<'SQL'
                    SELECT id, principal_amount, interest_rate, interest_amount, total_repayable,
                           amount_paid, balance, status, purpose, application_date, approval_date,
                           disbursement_date, due_date
                      FROM loans WHERE member_id = ?
                     ORDER BY application_date DESC
                    SQL,
                [$memberId]
            );

            // The interest/principal split, so the member can see exactly what
            // they still owe and how much of it is interest.
            $loans = array_map([LoanMath::class, 'decorateLoan'], $applications);
            $loanSummary = LoanMath::summarise($loans);

            $welfareRequests = Database::all(
                <<<'SQL'
                    SELECT id, amount, reason, status, request_date, approval_date
                      FROM welfare_requests WHERE member_id = ?
                     ORDER BY request_date DESC LIMIT 5
                    SQL,
                [$memberId]
            );

            $recentTransactions = Database::all(
                'SELECT * FROM contributions WHERE member_id = ? ORDER BY created_at DESC LIMIT 5',
                [$memberId]
            );

            Response::json([
                'member' => $member,
                'total_contributions' => $contributions,
                'loan_balance' => (float) $loanTotals,
                'loans' => $loans,
                'loan_summary' => $loanSummary,
                'welfare_requests' => $welfareRequests,
                'recent_transactions' => $recentTransactions,
            ]);
        } catch (\Throwable $e) {
            Log::warn('getMemberDashboard: ' . $e->getMessage());
            Response::error('Failed to fetch dashboard data.', 500);
        }
    }

    /** Pending self-registrations awaiting a decision. */
    public static function getPendingMembers(Request $r): void
    {
        try {
            $pending = Database::all(
                <<<'SQL'
                    SELECT id, full_name, email, phone, id_number, status, joined_date,
                           emergency_contact_name, emergency_contact_phone, created_at
                      FROM members
                     WHERE status = 'pending'
                     ORDER BY created_at ASC
                    SQL
            );

            $rejected = Database::all(
                <<<'SQL'
                    SELECT id, full_name, phone, rejection_reason, approved_at AS reviewed_at
                      FROM members
                     WHERE status = 'rejected'
                     ORDER BY approved_at DESC
                     LIMIT 20
                    SQL
            );

            // SUM rather than COUNT, so an empty table reports 0 for each rather
            // than null - the registrations screen adds these and null would show
            // as "NaN" beside the number.
            $counts = Database::one(
                <<<'SQL'
                    SELECT
                      COALESCE(SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END), 0) AS pending,
                      COALESCE(SUM(CASE WHEN status = 'active'   THEN 1 ELSE 0 END), 0) AS active,
                      COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected
                      FROM members
                    SQL
            );

            Response::json([
                'pending' => $pending,
                'recently_rejected' => $rejected,
                'counts' => $counts,
            ]);
        } catch (\Throwable $e) {
            Log::warn('getPendingMembers: ' . $e->getMessage());
            Response::error('Failed to load registrations.', 500);
        }
    }

    // ---------------------------------------------------------------- writes

    /** Creates a member directly. Active immediately, unlike a self-registration. */
    public static function createMember(Request $r): void
    {
        try {
            $body = $r->body();

            $fullName = $body['full_name'] ?? null;
            $phone = $body['phone'] ?? null;
            $password = $body['password'] ?? null;

            if (!$fullName || !$phone || !$password) {
                Response::error('Full name, phone, and password are required.', 400);
            }

            $existing = Database::one('SELECT id FROM members WHERE phone = ?', [$phone]);
            if ($existing !== null) {
                Response::error('Phone number already registered.', 409);
            }

            // Active, because an admin adding somebody has already decided they
            // belong. The column default is 'pending' for self-registrations,
            // which do need reviewing.
            $id = Database::insert(
                <<<'SQL'
                    INSERT INTO members (full_name, email, phone, id_number, password_hash, status,
                      emergency_contact_name, emergency_contact_phone, joined_date)
                    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, CURDATE())
                    SQL,
                [
                    $fullName,
                    !empty($body['email']) ? $body['email'] : null,
                    $phone,
                    !empty($body['id_number']) ? $body['id_number'] : null,
                    password_hash($password, PASSWORD_BCRYPT, ['cost' => self::BCRYPT_COST]),
                    !empty($body['emergency_contact_name']) ? $body['emergency_contact_name'] : null,
                    !empty($body['emergency_contact_phone']) ? $body['emergency_contact_phone'] : null,
                ]
            );

            Response::json([
                'success' => true,
                'member_id' => $id,
                'message' => 'Member created successfully.',
            ], 201);
        } catch (\Throwable $e) {
            Log::warn('createMember: ' . $e->getMessage());
            Response::error('Failed to create member.', 500);
        }
    }

    /**
     * Updates a member.
     *
     * Every field is written from the request, including empty ones. That is
     * deliberate and matches the Node version: the admin form always sends the
     * whole record, so a cleared field should be cleared rather than silently
     * kept. A partial update here would leave the UI and the database
     * disagreeing about the same member.
     */
    public static function updateMember(Request $r): void
    {
        try {
            $id = $r->param('id');
            $body = $r->body();

            Database::run(
                <<<'SQL'
                    UPDATE members
                       SET full_name = ?, email = ?, phone = ?, id_number = ?, status = ?,
                           emergency_contact_name = ?, emergency_contact_phone = ?
                     WHERE id = ?
                    SQL,
                [
                    $body['full_name'] ?? null,
                    $body['email'] ?? null,
                    $body['phone'] ?? null,
                    $body['id_number'] ?? null,
                    $body['status'] ?? null,
                    $body['emergency_contact_name'] ?? null,
                    $body['emergency_contact_phone'] ?? null,
                    $id,
                ]
            );

            Response::json(['success' => true, 'message' => 'Member updated successfully.']);
        } catch (\Throwable $e) {
            Log::warn('updateMember: ' . $e->getMessage());
            Response::error('Failed to update member.', 500);
        }
    }

    /**
     * Deletes a member, or refuses and explains why not.
     *
     * Refusing is the point. A member with contributions, loans or ledger
     * entries cannot be removed without rewriting history, so the response names
     * exactly what is in the way and offers deactivation instead - which stops
     * them signing in and keeps every record.
     */
    public static function deleteMember(Request $r): void
    {
        try {
            $id = $r->param('id');

            $existing = Database::one('SELECT id, full_name FROM members WHERE id = ?', [$id]);
            if ($existing === null) {
                // Previously this reported success while deleting nothing.
                Response::error('Member not found.', 404);
            }

            $counts = self::countHistoryFor([$id])[(string) $id] ?? [];
            $blockers = self::describeBlockers($counts);

            if ($blockers !== []) {
                Response::json([
                    'error' => sprintf(
                        '%s cannot be deleted because they have %s. Deleting would change your '
                        . 'savings records and past reports. Deactivate the member instead - they '
                        . 'stop signing in and all history is kept.',
                        $existing['full_name'],
                        implode(', ', $blockers)
                    ),
                    'reason' => 'has_history',
                    'blockers' => $blockers,
                    'counts' => (object) $counts,
                    'can_deactivate' => true,
                ], 409);
            }

            Database::transaction(function ($pdo) use ($id): void {
                // No financial history, so clearing notifications is safe and keeps
                // the delete from tripping the last foreign key.
                $pdo->prepare('DELETE FROM notifications WHERE member_id = ?')->execute([$id]);
                $pdo->prepare('DELETE FROM members WHERE id = ?')->execute([$id]);
            });

            Response::json([
                'success' => true,
                'message' => $existing['full_name'] . ' deleted.',
            ]);
        } catch (\Throwable $e) {
            // Safety net: a linked row in a table not listed above would otherwise
            // surface as a bare "Failed to delete member", naming neither the
            // constraint nor the way out.
            if ($e instanceof PDOException && $e->getCode() === '23000') {
                $constraint = null;
                if (preg_match('/CONSTRAINT `([^`]+)`/', $e->getMessage(), $m) === 1) {
                    $constraint = $m[1];
                }

                Response::json([
                    'error' => 'This member still has records attached, so deleting them would change '
                        . 'your savings history. Deactivate the member instead.',
                    'reason' => 'has_history',
                    'constraint' => $constraint,
                    'can_deactivate' => true,
                ], 409);
            }

            Log::warn('deleteMember: ' . $e->getMessage());
            Response::error('Failed to delete member.', 500);
        }
    }

    /**
     * Changes a member's status: active, inactive or suspended.
     *
     * Separate from the general update because it is the alternative to deleting
     * somebody with history, and because it refuses illegal values rather than
     * storing whatever arrives.
     */
    public static function setMemberStatus(Request $r): void
    {
        try {
            $id = $r->param('id');
            $status = $r->body()['status'] ?? null;
            $allowed = ['active', 'inactive', 'suspended'];

            if (!in_array($status, $allowed, true)) {
                Response::error('Status must be one of: ' . implode(', ', $allowed) . '.', 400);
            }

            $member = Database::one(
                'SELECT id, full_name, status FROM members WHERE id = ?',
                [$id]
            );

            if ($member === null) {
                Response::error('Member not found.', 404);
            }

            if ($member['status'] === $status) {
                Response::json([
                    'success' => true,
                    'status' => $status,
                    'message' => sprintf('%s is already %s.', $member['full_name'], $status),
                ]);
            }

            Database::run('UPDATE members SET status = ? WHERE id = ?', [$status, $id]);

            Response::json([
                'success' => true,
                'status' => $status,
                'message' => $status === 'active'
                    ? $member['full_name'] . ' reactivated.'
                    : sprintf(
                        '%s is now %s and can no longer sign in. All their records are kept.',
                        $member['full_name'],
                        $status
                    ),
            ]);
        } catch (\Throwable $e) {
            Log::warn('setMemberStatus: ' . $e->getMessage());
            Response::error('Failed to update the member status.', 500);
        }
    }

    /** Approves a pending registration. They can log in immediately afterwards. */
    public static function approveMember(Request $r): void
    {
        try {
            $id = $r->param('id');

            $row = Database::one(
                "SELECT id, full_name FROM members WHERE id = ? AND status = 'pending'",
                [$id]
            );

            if ($row === null) {
                Response::error('No pending registration with that id.', 404);
            }

            Database::run(
                <<<'SQL'
                    UPDATE members
                       SET status = 'active',
                           approved_by = ?,
                           approved_at = NOW(),
                           reviewed_by = ?,
                           rejection_reason = NULL
                     WHERE id = ?
                    SQL,
                [$r->user['id'], $r->user['id'], $id]
            );

            Response::json([
                'success' => true,
                'message' => $row['full_name'] . ' approved. They can now log in.',
            ]);
        } catch (\Throwable $e) {
            Log::warn('approveMember: ' . $e->getMessage());
            Response::error('Failed to approve the registration.', 500);
        }
    }

    /** Rejects a pending registration, with a reason the applicant can be told. */
    public static function rejectMember(Request $r): void
    {
        try {
            $id = $r->param('id');
            $reason = $r->body()['reason'] ?? null;

            if ($reason === null || trim((string) $reason) === '') {
                Response::error('Please give a reason for rejecting.', 400);
            }

            $row = Database::one(
                "SELECT id, full_name FROM members WHERE id = ? AND status = 'pending'",
                [$id]
            );

            if ($row === null) {
                Response::error('No pending registration with that id.', 404);
            }

            // Truncated because the column is 255 characters and a long reason
            // would otherwise fail the whole insert - losing the rejection
            // because someone typed a sentence.
            $reason = mb_substr(trim((string) $reason), 0, 255);

            Database::run(
                <<<'SQL'
                    UPDATE members
                       SET status = 'rejected',
                           rejection_reason = ?,
                           reviewed_by = ?,
                           approved_at = NOW()
                     WHERE id = ?
                    SQL,
                [$reason, $r->user['id'], $id]
            );

            Response::json([
                'success' => true,
                'message' => $row['full_name'] . ' was declined.',
            ]);
        } catch (\Throwable $e) {
            Log::warn('rejectMember: ' . $e->getMessage());
            Response::error('Failed to reject the registration.', 500);
        }
    }

    // ---------------------------------------------------------------- helpers

    /**
     * Counts linked rows in every history table, in one query.
     *
     * Takes one member or the whole list, so the members screen can show who is
     * protected by history without a request per row. UNION ALL keeps it to one
     * round trip; each COUNT rides an indexed foreign key.
     *
     * @return array<string, array<string, int>> Keyed by member id, then table
     */
    private static function countHistoryFor(array $ids): array
    {
        $byMember = [];

        $ids = array_values(array_filter($ids, static fn($id) => $id !== null && $id !== ''));
        if ($ids === []) {
            return $byMember;
        }

        // Built as (src, member_id, n) rows for every table, then folded in PHP.
        // The table and column names are literals from a constant above, never
        // anything from the request, so there is no injection surface here.
        $selects = [];
        $params = [];

        foreach (self::HISTORY_TABLES as $table) {
            foreach ($ids as $id) {
                $selects[] = sprintf(
                    "SELECT '%s' AS src, ? AS member_id, COUNT(*) AS n FROM %s WHERE member_id = ?",
                    $table['table'],
                    $table['table']
                );
                $params[] = $id;
                $params[] = $id;
            }
        }

        $rows = Database::all(
            'SELECT src, member_id, n FROM (' . implode(' UNION ALL ', $selects) . ') AS counts WHERE n > 0',
            $params
        );

        foreach ($rows as $row) {
            $key = (string) $row['member_id'];
            $byMember[$key] ??= [];
            $byMember[$key][$row['src']] = (int) $row['n'];
        }

        return $byMember;
    }

    /**
     * Human sentence naming what blocks a delete: "3 contributions, 1 loan".
     *
     * Singular and plural are both handled because "1 contributions" in an
     * explanation reads as a bug in the app.
     *
     * @return string[]
     */
    private static function describeBlockers(array $counts): array
    {
        $blockers = [];

        foreach (self::HISTORY_TABLES as $table) {
            $count = $counts[$table['table']] ?? 0;
            if ($count > 0) {
                $blockers[] = $count . ' ' . ($count === 1 ? $table['label'] : $table['plural']);
            }
        }

        return $blockers;
    }
}