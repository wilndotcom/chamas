<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Database;
use TheTeam\Log;
use TheTeam\Request;
use TheTeam\Response;

/**
 * Savings contributions.
 *
 * A port of backend/controllers/contributionController.js.
 *
 * Contributions are trust money: the group holds it on a member's behalf rather
 * than having earned it. That is why nothing here treats a contribution as
 * income, and why recording one is deliberately the simplest operation in the
 * system - it moves a figure and writes a ledger line, and nothing else.
 */
final class ContributionController
{
    /** Every contribution, newest first. */
    public static function getAllContributions(Request $r): void
    {
        try {
            $contributions = Database::all(
                <<<'SQL'
                    SELECT c.*, m.full_name AS member_name, a.full_name AS recorded_by_name
                      FROM contributions c
                      JOIN members m ON c.member_id = m.id
                      LEFT JOIN admins a ON c.recorded_by = a.id
                     ORDER BY c.created_at DESC
                    SQL
            );

            Response::json(['contributions' => $contributions]);
        } catch (\Throwable $e) {
            Log::warn('getAllContributions: ' . $e->getMessage());
            Response::error('Failed to fetch contributions.', 500);
        }
    }

    /**
     * Records a contribution.
     *
     * Marked 'confirmed' on the way in, because an admin entering a payment is
     * recording something that already happened. M-Pesa payments arrive through
     * their own callback, which confirms them separately.
     */
    public static function recordContribution(Request $r): void
    {
        try {
            $body = $r->body();

            $memberId = $body['member_id'] ?? null;
            $amount = $body['amount'] ?? null;
            $date = $body['contribution_date'] ?? null;

            if (!$memberId || !$amount || !$date) {
                Response::error('Member, amount, and date are required.', 400);
            }

            // Rejected here rather than trusted through: a negative contribution
            // would reduce the group's savings total without any record of who
            // took the money out, and the member's own balance would silently
            // disagree with the ledger.
            if (!is_numeric($amount) || (float) $amount <= 0) {
                Response::error('The amount must be greater than zero.', 400);
            }

            $member = Database::one('SELECT id FROM members WHERE id = ?', [$memberId]);
            if ($member === null) {
                Response::error('That member was not found.', 404);
            }

            $id = Database::insert(
                <<<'SQL'
                    INSERT INTO contributions
                      (member_id, amount, contribution_date, payment_method,
                       reference_number, status, remarks, recorded_by)
                    VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)
                    SQL,
                [
                    $memberId,
                    $amount,
                    $date,
                    !empty($body['payment_method']) ? $body['payment_method'] : 'cash',
                    !empty($body['reference_number']) ? $body['reference_number'] : null,
                    !empty($body['remarks']) ? $body['remarks'] : null,
                    $r->user['id'],
                ]
            );

            Response::json([
                'success' => true,
                'contribution_id' => $id,
                'message' => 'Contribution recorded successfully.',
            ], 201);
        } catch (\Throwable $e) {
            Log::warn('recordContribution: ' . $e->getMessage());
            Response::error('Failed to record contribution.', 500);
        }
    }

    /** One member's contributions. */
    public static function getMemberContributions(Request $r): void
    {
        try {
            $memberId = $r->param('member_id');

            $contributions = Database::all(
                'SELECT * FROM contributions WHERE member_id = ? ORDER BY contribution_date DESC',
                [$memberId]
            );

            Response::json(['contributions' => $contributions]);
        } catch (\Throwable $e) {
            Log::warn('getMemberContributions: ' . $e->getMessage());
            Response::error('Failed to fetch contributions.', 500);
        }
    }

    /** Totals across all confirmed contributions, for the dashboard and reports. */
    public static function getContributionSummary(Request $r): void
    {
        try {
            $summary = Database::one(
                <<<'SQL'
                    SELECT
                      COUNT(*) AS total_contributions,
                      COALESCE(SUM(amount), 0) AS total_amount,
                      COALESCE(AVG(amount), 0) AS average_amount,
                      COUNT(DISTINCT member_id) AS contributing_members
                      FROM contributions WHERE status = 'confirmed'
                    SQL
            );

            // Newest month first, then reversed by the frontend for the chart,
            // which reads left to right.
            $monthly = Database::all(
                <<<'SQL'
                    SELECT DATE_FORMAT(contribution_date, '%Y-%m') AS month,
                           COALESCE(SUM(amount), 0) AS total
                      FROM contributions WHERE status = 'confirmed'
                     GROUP BY DATE_FORMAT(contribution_date, '%Y-%m')
                     ORDER BY month DESC LIMIT 12
                    SQL
            );

            Response::json(['summary' => $summary, 'monthly' => $monthly]);
        } catch (\Throwable $e) {
            Log::warn('getContributionSummary: ' . $e->getMessage());
            Response::error('Failed to fetch summary.', 500);
        }
    }
}