<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Database;
use TheTeam\Log;
use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Utils\LoanMath;
use TheTeam\Utils\RiskMembers;
use TheTeam\Utils\Settings;

/**
 * Reports: growth, interest, profit, statements and expenses.
 *
 * A port of backend/controllers/reportController.js.
 *
 * One correction rather than a faithful port. Interest charged is not interest
 * earned: writing a loan does not earn anything, and a member who takes a 1,000
 * loan at 10% and pays nothing back has earned the group nothing. The Node
 * version sums interest_amount and reports it as income, so a group that lent out
 * everything and collected nothing looks profitable on paper.
 *
 * Earned interest is computed here as the interest portion of what has actually
 * been repaid, the same basis the transparency screen and each member's own loan
 * screen use, so all three agree.
 */
final class ReportController
{
    /** Chama growth, interest and profit. */
    public static function getGrowthMetrics(Request $r): void
    {
        try {
            $loanRate = Settings::getNumber('loan_interest_rate', 10);
            $savingsRate = Settings::getNumber('savings_interest_rate', 5);

            /* ------------------------------------------------------ month series */

            $since = "DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 11 MONTH), '%Y-%m-01')";

            $contributionsByMonth = Database::all(
                "SELECT DATE_FORMAT(contribution_date, '%Y-%m') AS ym,
                        COALESCE(SUM(amount), 0) AS total
                   FROM contributions
                  WHERE status = 'confirmed' AND contribution_date >= {$since}
                  GROUP BY ym"
            );

            $welfareByMonth = Database::all(
                "SELECT DATE_FORMAT(contribution_date, '%Y-%m') AS ym,
                        COALESCE(SUM(amount), 0) AS total
                   FROM welfare_contributions
                  WHERE status = 'confirmed' AND contribution_date >= {$since}
                  GROUP BY ym"
            );

            $disbursedByMonth = Database::all(
                "SELECT DATE_FORMAT(disbursement_date, '%Y-%m') AS ym,
                        COALESCE(SUM(principal_amount), 0) AS total
                   FROM loans
                  WHERE disbursement_date IS NOT NULL AND disbursement_date >= {$since}
                  GROUP BY ym"
            );

            $repaidByMonth = Database::all(
                "SELECT DATE_FORMAT(payment_date, '%Y-%m') AS ym,
                        COALESCE(SUM(amount), 0) AS total
                   FROM loan_repayments
                  WHERE payment_date >= {$since}
                  GROUP BY ym"
            );

            $expensesByMonth = Database::all(
                "SELECT DATE_FORMAT(expense_date, '%Y-%m') AS ym,
                        COALESCE(SUM(amount), 0) AS total
                   FROM expenses
                  WHERE expense_date >= {$since}
                  GROUP BY ym"
            );

            /*
             * A dense twelve-month series, so gaps render as zero rather than as
             * holes in the line.
             */
            $buckets = [];
            $cursor = (new \DateTimeImmutable('first day of this month'))->setTime(0, 0);

            for ($i = 11; $i >= 0; $i--) {
                $month = $cursor->modify("-{$i} months");
                $key = $month->format('Y-m');

                $buckets[$key] = [
                    'key' => $key,
                    // English month names on purpose: these are axis labels, and a
                    // label that changes with the server's locale makes the same
                    // chart look different on two machines.
                    'label' => $month->format('M'),
                    'year' => (int) $month->format('Y'),
                    'contributions' => 0.0,
                    'welfare' => 0.0,
                    'loans_disbursed' => 0.0,
                    'interest_earned' => 0.0,
                    'repayments' => 0.0,
                    'expenses' => 0.0,
                    'cumulative_savings' => 0.0,
                ];
            }

            $put = static function (array $rows, string $field) use (&$buckets): void {
                foreach ($rows as $row) {
                    if (isset($buckets[$row['ym']])) {
                        $buckets[$row['ym']][$field] = LoanMath::round2($row['total']);
                    }
                }
            };

            $put($contributionsByMonth, 'contributions');
            $put($welfareByMonth, 'welfare');
            $put($disbursedByMonth, 'loans_disbursed');
            $put($repaidByMonth, 'repayments');
            $put($expensesByMonth, 'expenses');

            // Savings before this window, so the cumulative line starts from the
            // true total rather than from twelve months ago.
            $carry = (float) Database::scalar(
                "SELECT COALESCE(SUM(amount), 0) FROM contributions
                  WHERE status = 'confirmed' AND contribution_date < {$since}"
            );

            $running = $carry;

            foreach ($buckets as $key => $bucket) {
                $running += $bucket['contributions'];
                $buckets[$key]['cumulative_savings'] = LoanMath::round2($running);
            }

            $monthly = array_values($buckets);

            /*
             * Interest earned, per month.
             *
             * Allocated by the month the repayments arrived in, which is when the
             * money was actually received. Charging it in the month the loan was
             * written would report income for a month in which none was collected.
             */
            foreach (self::monthlyInterestEarned($since) as $ym => $amount) {
                if (isset($buckets[$ym])) {
                    $buckets[$ym]['interest_earned'] = LoanMath::round2($amount);
                }
            }

            $monthly = array_values($buckets);

            /* ------------------------------------------------------------ summary */

            $totals = Database::one(
                <<<'SQL'
                    SELECT
                      (SELECT COALESCE(SUM(amount), 0) FROM contributions WHERE status = 'confirmed')   AS total_savings,
                      (SELECT COALESCE(SUM(amount), 0) FROM welfare_contributions WHERE status = 'confirmed') AS welfare_in,
                      (SELECT COALESCE(SUM(amount), 0) FROM expenses)                          AS total_expenses,
                      (SELECT COUNT(*) FROM members WHERE status = 'active')                      AS member_count,
                      (SELECT COUNT(*) FROM members
                         WHERE joined_date >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')) AS new_members_month
                    SQL
            );

            $loanRows = Database::one(
                <<<'SQL'
                    SELECT
                      COALESCE(SUM(CASE WHEN status IN ('active','completed') THEN principal_amount ELSE 0 END), 0) AS disbursed,
                      COALESCE(SUM(CASE WHEN status IN ('active','disbursed') THEN balance ELSE 0 END), 0)        AS outstanding,
                      COALESCE(SUM(CASE WHEN status IN ('active','completed') THEN amount_paid ELSE 0 END), 0)    AS recovered,
                      COALESCE(SUM(CASE WHEN status = 'defaulted' THEN balance ELSE 0 END), 0)                   AS defaulted_amount,
                      COALESCE(SUM(CASE WHEN status IN ('active','disbursed') THEN 1 ELSE 0 END), 0)              AS active_count,
                      COALESCE(SUM(CASE WHEN status = 'defaulted' THEN 1 ELSE 0 END), 0)                        AS defaulted_count,
                      COUNT(*)                                                                                  AS total_count
                    FROM loans
                    SQL
            );

            $welfareOut = (float) Database::scalar(
                "SELECT COALESCE(SUM(amount), 0) FROM welfare_requests
                  WHERE status IN ('approved','disbursed')"
            );

            $totalSavings = (float) $totals['total_savings'];
            $memberCount = (int) $totals['member_count'];

            $thisMonth = $monthly[count($monthly) - 1]['contributions'];
            $lastMonth = $monthly[count($monthly) - 2]['contributions'] ?? 0;

            $growthRate = $lastMonth > 0
                ? LoanMath::round2((($thisMonth - $lastMonth) / $lastMonth) * 100)
                : 0.0;

            $interestEarned = self::totalInterestEarned();
            $interestPayable = LoanMath::round2(($totalSavings * $savingsRate) / 100);
            $expenses = (float) $totals['total_expenses'];
            $loanLosses = (float) $loanRows['defaulted_amount'];

            $netProfit = LoanMath::round2($interestEarned - $expenses - $loanLosses);

            $disbursed = (float) $loanRows['disbursed'];
            $outstanding = (float) $loanRows['outstanding'];
            $recovered = (float) $loanRows['recovered'];

            Response::json([
                'summary' => [
                    'total_savings' => LoanMath::round2($totalSavings),
                    'savings_this_month' => LoanMath::round2($thisMonth),
                    'savings_last_month' => LoanMath::round2($lastMonth),
                    'growth_rate' => $growthRate,
                    'member_count' => $memberCount,
                    'new_members_this_month' => (int) $totals['new_members_month'],
                    'average_per_member' => LoanMath::round2(
                        $memberCount > 0 ? $totalSavings / $memberCount : 0
                    ),
                ],

                'interest' => [
                    'rate' => $loanRate,
                    'total_earned' => LoanMath::round2($interestEarned),
                    'earned_this_month' => LoanMath::round2($monthly[count($monthly) - 1]['interest_earned']),
                    'savings_rate' => $savingsRate,

                    // A liability: owed to members if they leave, not income.
                    'payable_to_members' => $interestPayable,
                    'net_position' => LoanMath::round2($interestEarned - $interestPayable),
                ],

                'profit' => [
                    'income' => LoanMath::round2($interestEarned),
                    'expenses' => LoanMath::round2($expenses),
                    'loan_losses' => LoanMath::round2($loanLosses),
                    'net_profit' => $netProfit,
                    'margin' => $interestEarned > 0
                        ? LoanMath::round2(($netProfit / $interestEarned) * 100)
                        : 0.0,
                ],

                'loans' => [
                    'disbursed' => LoanMath::round2($disbursed),
                    'outstanding' => LoanMath::round2($outstanding),
                    'recovered' => LoanMath::round2($recovered),
                    'recovery_rate' => $disbursed > 0
                        ? LoanMath::round2(($recovered / $disbursed) * 100)
                        : 0.0,
                    'active_count' => (int) $loanRows['active_count'],
                    'defaulted_count' => (int) $loanRows['defaulted_count'],
                    'default_rate' => (int) $loanRows['total_count'] > 0
                        ? LoanMath::round2(
                            ((int) $loanRows['defaulted_count'] / (int) $loanRows['total_count']) * 100
                        )
                        : 0.0,
                ],

                'welfare' => [
                    'contributed' => LoanMath::round2($totals['welfare_in']),
                    'disbursed' => LoanMath::round2($welfareOut),
                    'balance' => LoanMath::round2(((float) $totals['welfare_in']) - $welfareOut),
                ],

                'monthly' => $monthly,
            ]);
        } catch (\Throwable $e) {
            Log::warn('getGrowthMetrics: ' . $e->getMessage());
            Response::error('Failed to generate growth metrics.', 500);
        }
    }

    /** Members who have not paid, are behind, or have an overdue loan. */
    public static function getReminders(Request $r): void
    {
        try {
            Response::json(RiskMembers::find());
        } catch (\Throwable $e) {
            Log::warn('getReminders: ' . $e->getMessage());
            Response::error('Failed to load reminders.', 500);
        }
    }

    /** Headline totals for the admin dashboard. */
    public static function getFinancialSummary(Request $r): void
    {
        try {
            $contributions = Database::scalar(
                "SELECT COALESCE(SUM(amount), 0) FROM contributions WHERE status = 'confirmed'"
            );

            $loans = Database::one(
                "SELECT COALESCE(SUM(total_repayable), 0) AS total_disbursed,
                        COALESCE(SUM(balance), 0) AS total_outstanding
                   FROM loans WHERE status IN ('active', 'disbursed', 'completed')"
            );

            $welfare = Database::scalar(
                "SELECT COALESCE(SUM(amount), 0) FROM welfare_contributions WHERE status = 'confirmed'"
            );

            $members = Database::scalar(
                "SELECT COUNT(*) FROM members WHERE status = 'active'"
            );

            Response::json([
                'total_contributions' => LoanMath::round2($contributions),
                'total_loans_disbursed' => LoanMath::round2($loans['total_disbursed']),
                'total_loans_outstanding' => LoanMath::round2($loans['total_outstanding']),
                'total_welfare' => LoanMath::round2($welfare),
                'active_members' => (int) $members,
            ]);
        } catch (\Throwable $e) {
            Log::warn('getFinancialSummary: ' . $e->getMessage());
            Response::error('Failed to generate report.', 500);
        }
    }

    /** One month's activity. */
    public static function getMonthlyReport(Request $r): void
    {
        try {
            $now = new \DateTimeImmutable('today');

            $year = preg_match('/^\d{4}$/', (string) $r->query('year'))
                ? (int) $r->query('year')
                : (int) $now->format('Y');

            $month = preg_match('/^\d{1,2}$/', (string) $r->query('month'))
                ? (int) $r->query('month')
                : (int) $now->format('n');

            Response::json([
                'period' => sprintf('%04d-%02d', $year, $month),
                'contributions' => Database::one(
                    "SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
                       FROM contributions
                      WHERE status = 'confirmed'
                        AND YEAR(contribution_date) = ? AND MONTH(contribution_date) = ?",
                    [$year, $month]
                ),
                'loans_approved' => Database::one(
                    "SELECT COALESCE(SUM(total_repayable), 0) AS total, COUNT(*) AS count
                       FROM loans
                      WHERE YEAR(application_date) = ? AND MONTH(application_date) = ?",
                    [$year, $month]
                ),
                'loan_repayments' => Database::one(
                    'SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
                       FROM loan_repayments
                      WHERE YEAR(payment_date) = ? AND MONTH(payment_date) = ?',
                    [$year, $month]
                ),
            ]);
        } catch (\Throwable $e) {
            Log::warn('getMonthlyReport: ' . $e->getMessage());
            Response::error('Failed to generate monthly report.', 500);
        }
    }

    /** Everything one member has done with the group. */
    public static function getMemberStatement(Request $r): void
    {
        try {
            $memberId = $r->param('member_id');

            Response::json([
                'contributions' => Database::all(
                    "SELECT * FROM contributions WHERE member_id = ? AND status = 'confirmed'
                      ORDER BY contribution_date DESC",
                    [$memberId]
                ),
                'loans' => Database::all(
                    'SELECT * FROM loans WHERE member_id = ? ORDER BY application_date DESC',
                    [$memberId]
                ),
                'repayments' => Database::all(
                    'SELECT * FROM loan_repayments WHERE member_id = ? ORDER BY payment_date DESC',
                    [$memberId]
                ),
            ]);
        } catch (\Throwable $e) {
            Log::warn('getMemberStatement: ' . $e->getMessage());
            Response::error('Failed to generate statement.', 500);
        }
    }

    // -------------------------------------------------------------- expenses

    public static function getExpenses(Request $r): void
    {
        try {
            $expenses = Database::all(
                <<<'SQL'
                    SELECT e.*, a.full_name AS recorded_by_name
                      FROM expenses e
                      LEFT JOIN admins a ON e.recorded_by = a.id
                     ORDER BY e.expense_date DESC, e.id DESC
                     LIMIT 200
                    SQL
            );

            $totals = Database::one(
                <<<'SQL'
                    SELECT COALESCE(SUM(amount), 0) AS total,
                           COALESCE(SUM(CASE
                             WHEN expense_date >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
                             THEN amount ELSE 0 END), 0) AS this_month
                      FROM expenses
                    SQL
            );

            $byCategory = Database::all(
                'SELECT category, COALESCE(SUM(amount), 0) AS total
                   FROM expenses GROUP BY category ORDER BY total DESC'
            );

            Response::json([
                'expenses' => $expenses,
                'totals' => [
                    'total' => LoanMath::round2($totals['total']),
                    'this_month' => LoanMath::round2($totals['this_month']),
                ],
                'by_category' => $byCategory,
            ]);
        } catch (\Throwable $e) {
            Log::warn('getExpenses: ' . $e->getMessage());
            Response::error('Failed to load expenses.', 500);
        }
    }

    public static function recordExpense(Request $r): void
    {
        try {
            $body = $r->body();

            $category = $body['category'] ?? null;
            $amount = $body['amount'] ?? null;
            $date = $body['expense_date'] ?? null;

            if (!$category || !$amount || !$date) {
                Response::error('Category, amount and date are required.', 400);
            }

            // A number rather than merely truthy: the old test accepted a string,
            // and a negative expense would have inflated the group's income.
            if (!is_numeric($amount) || (float) $amount <= 0) {
                Response::error('Amount must be greater than zero.', 400);
            }

            $expenseId = Database::insert(
                <<<'SQL'
                    INSERT INTO expenses
                      (category, description, amount, expense_date,
                       payment_method, reference_number, recorded_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    SQL,
                [
                    $category,
                    $body['description'] ?? null,
                    $amount,
                    $date,
                    $body['payment_method'] ?? 'cash',
                    $body['reference_number'] ?? null,
                    $r->user['id'],
                ]
            );

            Response::json([
                'success' => true,
                'expense_id' => $expenseId,
                'message' => 'Expense recorded.',
            ], 201);
        } catch (\Throwable $e) {
            Log::warn('recordExpense: ' . $e->getMessage());
            Response::error('Failed to record expense.', 500);
        }
    }

    public static function deleteExpense(Request $r): void
    {
        try {
            $statement = Database::run('DELETE FROM expenses WHERE id = ?', [$r->param('id')]);

            // Counted rather than assumed. Reporting success while deleting
            // nothing is how an expense stays on the books after the treasurer
            // believes they removed it.
            if ($statement->rowCount() === 0) {
                Response::error('Expense not found.', 404);
            }

            Response::json(['success' => true, 'message' => 'Expense deleted.']);
        } catch (\Throwable $e) {
            Log::warn('deleteExpense: ' . $e->getMessage());
            Response::error('Failed to delete expense.', 500);
        }
    }

    // -------------------------------------------------------------- helpers

    /**
     * Interest the group has actually earned, across every disbursed loan.
     *
     * Interest charged less the interest still outstanding on what remains. A
     * member who has repaid nothing has earned the group nothing.
     */
    private static function totalInterestEarned(): float
    {
        return array_sum(self::earnedPerLoan());
    }

    /**
     * The same figure, split by the month each repayment arrived in.
     *
     * Pro rata: each repayment is credited with its interest share first, so the
     * monthly total adds up to the lifetime total exactly. Approximating by
     * month would leave the series not summing to the summary, and a chart whose
     * parts do not add to its total is one nobody trusts.
     */
    private static function monthlyInterestEarned(string $since): array
    {
        $repayments = Database::all(
            <<<'SQL'
                SELECT loan_id, amount, DATE_FORMAT(payment_date, '%Y-%m') AS ym
                  FROM loan_repayments
                 WHERE payment_date >= ? AND amount > 0
                 ORDER BY payment_date ASC
                SQL,
            [$since]
        );

        $byMonth = [];

        foreach ($repayments as $repayment) {
            $loan = self::loanRow($repayment['loan_id']);

            if ($loan === null || $loan['total_repayable'] <= 0) {
                continue;
            }

            // The interest share of the total repayable, which is also the share
            // of every payment against it.
            $interestShare = $loan['interest_amount'] / $loan['total_repayable'];

            $byMonth[$repayment['ym']] =
                ($byMonth[$repayment['ym']] ?? 0)
                + ((float) $repayment['amount'] * $interestShare);
        }

        return $byMonth;
    }

    /** @return array<string, float> loan id => interest earned */
    private static function earnedPerLoan(): array
    {
        $loans = Database::all(
            <<<'SQL'
                SELECT id, principal_amount, interest_amount, total_repayable,
                       amount_paid, balance, status
                  FROM loans WHERE disbursement_date IS NOT NULL
                SQL
        );

        $earned = [];

        foreach ($loans as $loan) {
            $loan = LoanMath::decorateLoan($loan);

            // A settled loan has nothing outstanding, so all of its interest has
            // been earned.
            $earned[(string) $loan['id']] = max(
                0.0,
                (float) $loan['interest_amount'] - (float) $loan['interest_outstanding']
            );
        }

        return $earned;
    }

    /** One loan's figures, for the monthly allocation. Cached per request. */
    private static array $loanCache = [];

    private static function loanRow($loanId): ?array
    {
        $key = (string) $loanId;

        if (array_key_exists($key, self::$loanCache)) {
            return self::$loanCache[$key];
        }

        $row = Database::one(
            'SELECT principal_amount, interest_amount, total_repayable, amount_paid, balance, status
               FROM loans WHERE id = ?',
            [$loanId]
        );

        if ($row === null) {
            return self::$loanCache[$key] = null;
        }

        return self::$loanCache[$key] = array_map(
            static fn($v) => (float) $v,
            $row
        );
    }
}