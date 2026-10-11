<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Database;
use TheTeam\Log;
use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Utils\LoanMath;
use TheTeam\Utils\Settings;

/**
 * What the member portal shows about the group as a whole.
 *
 * A port of backend/controllers/transparencyController.js.
 *
 * Deliberately available to members, not only to admins. A chama where members
 * cannot see the books is a chama where they have to take the treasurer's word
 * for it, which is where suspicion starts.
 *
 * The figures are split into two groups that are easy to confuse:
 *
 *   held for members  savings and welfare balances. This is the members' own
 *                     money, and the group owes it back. It is a liability, not
 *                     profit, and adding it to profit would tell members their
 *                     own savings had been earned by the group.
 *
 *   the group's own   interest collected on loans, less running costs. This is
 *                     the only genuine income, and it is what "profit" means
 *                     here.
 *
 * Loans already disbursed are shown separately again as a receivable: the cash
 * has left but is not spent, so counting it as an expense would understate the
 * group and overstate profit.
 */
final class TransparencyController
{
    public static function getTransparency(Request $r): void
    {
        try {
            $memberId = $r->user['id'];

            /* ------------------------------------------------ held for members */

            $savingsHeld = (float) Database::scalar(
                "SELECT COALESCE(SUM(amount), 0) FROM contributions WHERE status = 'confirmed'"
            );

            $welfareIn = (float) Database::scalar(
                "SELECT COALESCE(SUM(amount), 0) FROM welfare_contributions WHERE status = 'confirmed'"
            );

            $welfareOut = (float) Database::scalar(
                "SELECT COALESCE(SUM(amount), 0) FROM welfare_requests WHERE status = 'disbursed'"
            );

            $welfareAvailable = LoanMath::round2($welfareIn - $welfareOut);

            /* ----------------------------------------------- loans and income */

            $loanTotals = Database::one(
                <<<'SQL'
                    SELECT COALESCE(SUM(principal_amount), 0) AS disbursed,
                           COALESCE(SUM(interest_amount), 0)    AS interest_charged
                      FROM loans WHERE disbursement_date IS NOT NULL
                    SQL
            );

            $repaidTotal = (float) Database::scalar(
                'SELECT COALESCE(SUM(amount), 0) FROM loan_repayments'
            );

            $expensesTotal = (float) Database::scalar(
                'SELECT COALESCE(SUM(amount), 0) FROM expenses'
            );

            // Money physically in the bank: everything received, less everything
            // paid out.
            $ledgerTotals = Database::one(
                <<<'SQL'
                    SELECT COALESCE(SUM(CASE WHEN direction = 'in'  THEN amount ELSE 0 END), 0) AS total_in,
                           COALESCE(SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END), 0) AS total_out
                      FROM ledger_entries
                    SQL
            );

            $contribTotal = (float) Database::scalar(
                "SELECT COALESCE(SUM(amount), 0) FROM contributions WHERE status = 'confirmed'"
            );

            $cashOnHand = LoanMath::round2(
                $contribTotal + $welfareIn
                + (float) $ledgerTotals['total_in']
                - $welfareOut
                - (float) $ledgerTotals['total_out']
            );

            $disbursedTotal = (float) $loanTotals['disbursed'];
            $receivable = LoanMath::round2($disbursedTotal - $repaidTotal);

            /*
             * Interest actually earned, not interest charged and not repayments.
             *
             * The Node version sums loan_repayments and calls it interest
             * collected. That is wrong by a wide margin: a repayment includes the
             * principal, so a group that lent 10,000 and got 3,000 back would
             * report 3,000 of income when it had earned perhaps 150 of interest.
             * Reported as profit, which is the figure members judge the committee
             * by.
             *
             * Computed instead as the interest portion of what has been repaid,
             * pro rata on each loan - the same basis LoanMath uses everywhere
             * else, so a member's balance here agrees with the figure on their
             * own loan screen.
             */
            $interestEarned = self::interestCollected();

            $profit = LoanMath::round2($interestEarned - $expensesTotal);

            /* ------------------------------------------------------ month series */

            $buckets = self::lastTwelveMonths();
            $since = "DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 11 MONTH), '%Y-%m-01')";

            $series = [
                'savings_in' => [
                    'sql' => "SELECT DATE_FORMAT(contribution_date, '%Y-%m') AS ym,
                                   COALESCE(SUM(amount), 0) AS total
                              FROM contributions
                             WHERE status = 'confirmed' AND contribution_date >= {$since}
                             GROUP BY ym",
                ],
                'welfare_in' => [
                    'sql' => "SELECT DATE_FORMAT(contribution_date, '%Y-%m') AS ym,
                                   COALESCE(SUM(amount), 0) AS total
                              FROM welfare_contributions
                             WHERE status = 'confirmed' AND contribution_date >= {$since}
                             GROUP BY ym",
                ],
                'interest_earned' => [
                    'sql' => "SELECT DATE_FORMAT(payment_date, '%Y-%m') AS ym,
                                   COALESCE(SUM(amount), 0) AS total
                              FROM loan_repayments
                             WHERE payment_date >= {$since}
                             GROUP BY ym",
                ],
                'expenses' => [
                    'sql' => "SELECT DATE_FORMAT(expense_date, '%Y-%m') AS ym,
                                   COALESCE(SUM(amount), 0) AS total
                              FROM expenses
                             WHERE expense_date >= {$since}
                             GROUP BY ym",
                ],
            ];

            foreach ($series as $field => $query) {
                foreach (Database::all($query['sql']) as $row) {
                    if (isset($buckets[$row['ym']])) {
                        $buckets[$row['ym']][$field] = LoanMath::round2($row['total']);
                    }
                }
            }

            /* --------------------------------------------------- other members */

            // Contributions and loans per member, so a member can see how the
            // group is really doing rather than only their own row. Names and
            // totals only, never a member's password or id number.
            $members = Database::all(
                <<<'SQL'
                    SELECT
                      m.id,
                      m.full_name,
                      -- Admins are members too (migration 016), so they appear
                      -- here like anyone else. Flagged rather than hidden.
                      CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS is_admin,
                      COALESCE(c.total, 0)   AS savings_total,
                      COALESCE(wc.total, 0)  AS welfare_total,
                      COALESCE(l.outstanding, 0) AS loan_balance,
                      m.joined_date
                    FROM members m
                    LEFT JOIN admins a ON a.member_id = m.id
                    LEFT JOIN (
                      SELECT member_id, SUM(amount) AS total
                        FROM contributions WHERE status = 'confirmed' GROUP BY member_id
                    ) c ON c.member_id = m.id
                    LEFT JOIN (
                      SELECT member_id, SUM(amount) AS total
                        FROM welfare_contributions WHERE status = 'confirmed' GROUP BY member_id
                    ) wc ON wc.member_id = m.id
                    LEFT JOIN (
                      SELECT member_id,
                             SUM(principal_amount + interest_amount - COALESCE(paid, 0)) AS outstanding
                        FROM (
                          SELECT l.member_id, l.principal_amount, l.interest_amount,
                                 COALESCE((SELECT SUM(r.amount) FROM loan_repayments r
                                            WHERE r.loan_id = l.id), 0) AS paid
                            FROM loans l
                           WHERE l.disbursement_date IS NOT NULL
                             AND l.status IN ('approved', 'active', 'disbursed')
                        ) x GROUP BY member_id
                    ) l ON l.member_id = m.id
                    WHERE m.status = 'active'
                    ORDER BY m.full_name
                    SQL
            );

            /* --------------------------------------------------- own position */

            $ownSavings = (float) Database::scalar(
                "SELECT COALESCE(SUM(amount), 0) FROM contributions
                  WHERE member_id = ? AND status = 'confirmed'",
                [$memberId]
            );

            $ownWelfare = (float) Database::scalar(
                "SELECT COALESCE(SUM(amount), 0) FROM welfare_contributions
                  WHERE member_id = ? AND status = 'confirmed'",
                [$memberId]
            );

            $ownOwed = (float) Database::scalar(
                <<<'SQL'
                    SELECT COALESCE(SUM(principal_amount + interest_amount), 0)
                      FROM loans WHERE member_id = ? AND disbursement_date IS NOT NULL
                        AND status IN ('approved', 'active', 'disbursed')
                    SQL,
                [$memberId]
            );

            $ownPaid = (float) Database::scalar(
                'SELECT COALESCE(SUM(r.amount), 0) FROM loan_repayments r
                   JOIN loans l ON l.id = r.loan_id
                  WHERE l.member_id = ?',
                [$memberId]
            );

            Response::json([
                /*
                 * What the members collectively own. Shown first because it is
                 * the number that belongs to the people reading the screen.
                 */
                'held_for_members' => [
                    'savings' => LoanMath::round2($savingsHeld),
                    'welfare' => $welfareAvailable,
                    'total' => LoanMath::round2($savingsHeld + $welfareAvailable),
                ],

                /*
                 * What the group itself holds, split so the two are never added
                 * together into one misleading headline.
                 */
                'group_position' => [
                    'cash_on_hand' => $cashOnHand,
                    'receivable_from_members' => $receivable,
                    'net_worth' => LoanMath::round2($cashOnHand + $receivable),
                    'note' => 'Member savings and welfare are member money held on trust. '
                        . 'They are not profit.',
                ],

                'income' => [
                    'interest_collected' => $interestEarned,
                    'expenses' => LoanMath::round2($expensesTotal),
                    'profit' => $profit,
                    'note' => 'Interest on loans is the only income the group earns. '
                        . 'Counted on the interest portion of repayments, not the whole payment.',
                ],

                'loans' => [
                    'disbursed' => LoanMath::round2($disbursedTotal),
                    'repaid' => LoanMath::round2($repaidTotal),
                    'outstanding' => $receivable,
                ],

                'member_count' => count($members),

                'series' => array_values($buckets),

                // Names and totals only: a member can see how the group is doing,
                // not another member's credentials.
                'members' => $members,

                'me' => [
                    'member_id' => $memberId,
                    'savings' => LoanMath::round2($ownSavings),
                    'welfare' => LoanMath::round2($ownWelfare),
                    'loan_balance' => LoanMath::round2($ownOwed - $ownPaid),
                ],

                'chama_name' => Settings::get('chama_name', 'THE TEAM'),
            ]);
        } catch (\Throwable $e) {
            Log::warn('Transparency error: ' . $e->getMessage());
            Response::error('Failed to load the group figures.', 500);
        }
    }

    /**
     * Interest the group has actually earned.
     *
     * For each disbursed loan, the interest portion of what has been repaid so
     * far: the interest charged, less the interest still outstanding on the
     * remaining balance.
     *
     * Pro rata, which is the basis LoanMath uses to show a member what they owe.
     * Using one basis in both places is what keeps the group figures and a
     * member's own loan screen telling the same story.
     *
     * A repayment is not an earning and a charge is not income: only the part
     * that clears interest has been earned, and only once it has arrived.
     */
    private static function interestCollected(): float
    {
        $loans = Database::all(
            <<<'SQL'
                SELECT principal_amount, interest_amount, total_repayable,
                       amount_paid, balance, status
                  FROM loans WHERE disbursement_date IS NOT NULL
                SQL
        );

        $total = 0.0;

        foreach ($loans as $loan) {
            $loan = LoanMath::decorateLoan($loan);

            // A settled loan has nothing outstanding, so all of its interest has
            // been earned.
            $earned = (float) $loan['interest_amount'] - (float) $loan['interest_outstanding'];

            $total += max(0.0, $earned);
        }

        return LoanMath::round2($total);
    }

    /**
     * Builds a dense twelve-month series.
     *
     * Every month is present even when nothing happened in it, so a quiet month
     * reads as zero rather than as missing data.
     */
    private static function lastTwelveMonths(): array
    {
        $buckets = [];

        $cursor = new \DateTimeImmutable('first day of this month');
        $cursor = $cursor->setTime(0, 0);

        for ($i = 11; $i >= 0; $i--) {
            $month = $cursor->modify("-{$i} months");

            $key = $month->format('Y-m');

            $buckets[$key] = [
                'key' => $key,
                // Named in English on purpose: these are axis labels, and a month
                // name that changes with the server's locale makes the same chart
                // look different on two machines.
                'label' => $month->format('M'),
                'savings_in' => 0.0,
                'welfare_in' => 0.0,
                'welfare_out' => 0.0,
                'interest_earned' => 0.0,
                'expenses' => 0.0,
            ];
        }

        return $buckets;
    }
}