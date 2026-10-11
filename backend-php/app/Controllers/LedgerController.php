<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Database;
use TheTeam\Log;
use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Utils\LoanMath;

/**
 * The cash book.
 *
 * A port of backend/controllers/ledgerController.js.
 *
 * Merges every source of cash into one ledger so the balance is explainable:
 *
 *   MONEY IN   member savings, loan repayments, welfare contributions, other income
 *   MONEY OUT  operating expenses, loans disbursed, welfare paid out, other spending
 *
 * Two distinctions matter and are reported separately, because collapsing them
 * makes the books wrong:
 *
 *   1. Loans disbursed leave the bank but are not spending. They become a
 *      receivable, so they sit in "money out" for the cash book but must be added
 *      back when working out what the chama actually owns.
 *   2. Member savings and welfare funds are member money held on trust. They are a
 *      liability, never profit.
 */
final class LedgerController
{
    /** The start of the window when no dates are given: twelve months back. */
    private static function defaultFrom(): string
    {
        $date = new \DateTimeImmutable('today');
        return $date->modify('-11 months')->modify('first day of this month')
            ->format('Y-m-d');
    }

    public static function getCashBook(Request $r): void
    {
        try {
            // Only a well-formed date is honoured. Anything else falls back to the
            // default rather than reaching the query and returning nothing, which
            // reads as "no money moved" when the real answer is "bad request".
            $from = preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $r->query('from'))
                ? (string) $r->query('from')
                : self::defaultFrom();

            $to = preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $r->query('to'))
                ? (string) $r->query('to')
                : (new \DateTimeImmutable('today'))->format('Y-m-d');

            $sum = static function (string $sql, array $params): array {
                $row = Database::one($sql, $params);
                return [
                    'total' => (float) ($row['total'] ?? 0),
                    'count' => (int) ($row['count'] ?? 0),
                ];
            };

            /* ---------------------------------------------------------- money in */

            $savingsIn = $sum(
                "SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
                   FROM contributions
                  WHERE status = 'confirmed' AND contribution_date BETWEEN ? AND ?",
                [$from, $to]
            );

            $repaymentsIn = $sum(
                'SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
                   FROM loan_repayments WHERE payment_date BETWEEN ? AND ?',
                [$from, $to]
            );

            $welfareIn = $sum(
                "SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
                   FROM welfare_contributions
                  WHERE status = 'confirmed' AND contribution_date BETWEEN ? AND ?",
                [$from, $to]
            );

            $otherIn = $sum(
                "SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
                   FROM ledger_entries
                  WHERE direction = 'in' AND entry_date BETWEEN ? AND ?",
                [$from, $to]
            );

            /* ------------------------------------------------------- money out */

            $expensesOut = $sum(
                'SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
                   FROM expenses WHERE expense_date BETWEEN ? AND ?',
                [$from, $to]
            );

            $loansOut = $sum(
                "SELECT COALESCE(SUM(principal_amount), 0) AS total, COUNT(*) AS count
                   FROM loans
                  WHERE disbursement_date IS NOT NULL
                    AND status IN ('active', 'disbursed', 'completed')
                    AND disbursement_date BETWEEN ? AND ?",
                [$from, $to]
            );

            $welfareOut = $sum(
                "SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
                   FROM welfare_requests
                  WHERE status IN ('approved', 'disbursed') AND request_date BETWEEN ? AND ?",
                [$from, $to]
            );

            $otherOut = $sum(
                "SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
                   FROM ledger_entries
                  WHERE direction = 'out' AND entry_date BETWEEN ? AND ?",
                [$from, $to]
            );

            $totalIn = $savingsIn['total'] + $repaymentsIn['total']
                + $welfareIn['total'] + $otherIn['total'];

            $totalOut = $expensesOut['total'] + $loansOut['total']
                + $welfareOut['total'] + $otherOut['total'];

            /* -------------------------------------------- opening balance (all time) */

            /*
             * Everything before the window, whatever its date.
             *
             * Not restricted to twelve months: the opening balance has to be the
             * real starting point, or a period report shows a group appearing to
             * start from nothing whenever the window moves.
             */
            $priorIn = (float) Database::scalar(
                <<<'SQL'
                    SELECT
                      (SELECT COALESCE(SUM(amount), 0) FROM contributions
                         WHERE status = 'confirmed' AND contribution_date < ?) +
                      (SELECT COALESCE(SUM(amount), 0) FROM loan_repayments WHERE payment_date < ?) +
                      (SELECT COALESCE(SUM(amount), 0) FROM welfare_contributions
                         WHERE status = 'confirmed' AND contribution_date < ?) +
                      (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries
                         WHERE direction = 'in' AND entry_date < ?)
                    SQL,
                [$from, $from, $from, $from]
            );

            $priorOut = (float) Database::scalar(
                <<<'SQL'
                    SELECT
                      (SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE expense_date < ?) +
                      (SELECT COALESCE(SUM(principal_amount), 0) FROM loans
                         WHERE disbursement_date IS NOT NULL
                           AND status IN ('active','disbursed','completed') AND disbursement_date < ?) +
                      (SELECT COALESCE(SUM(amount), 0) FROM welfare_requests
                         WHERE status IN ('approved','disbursed') AND request_date < ?) +
                      (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries
                         WHERE direction = 'out' AND entry_date < ?)
                    SQL,
                [$from, $from, $from, $from]
            );

            $openingBalance = $priorIn - $priorOut;
            $closingBalance = $openingBalance + $totalIn - $totalOut;

            /* ------------------------------- trust money and receivables (all time) */

            $position = Database::one(
                <<<'SQL'
                    SELECT
                      (SELECT COALESCE(SUM(amount), 0) FROM contributions
                         WHERE status = 'confirmed')                        AS savings_held,
                      (SELECT COALESCE(SUM(amount), 0) FROM welfare_contributions
                         WHERE status = 'confirmed')                        AS welfare_held,
                      (SELECT COALESCE(SUM(amount), 0) FROM welfare_requests
                         WHERE status IN ('approved','disbursed'))          AS welfare_paid,
                      (SELECT COALESCE(SUM(balance), 0) FROM loans
                         WHERE status IN ('active','disbursed'))            AS receivable
                    SQL
            );

            $savingsHeld = (float) $position['savings_held'];
            $welfareHeld = (float) $position['welfare_held'];
            $welfarePaid = (float) $position['welfare_paid'];
            $receivable = (float) $position['receivable'];

            $trustLiability = $savingsHeld + ($welfareHeld - $welfarePaid);

            // What the chama genuinely owns: cash plus what members owe it.
            $netWorth = $closingBalance + $receivable;

            /* ---------------------------------------------------- itemised ledger */

            $entries = Database::all(
                <<<'SQL'
                    SELECT 'savings' AS source, c.id, c.contribution_date AS entry_date, c.amount,
                           CONCAT('Monthly savings from ', m.full_name) AS description,
                           c.payment_method, c.reference_number, m.full_name AS member_name
                      FROM contributions c JOIN members m ON c.member_id = m.id
                     WHERE c.status = 'confirmed' AND c.contribution_date BETWEEN ? AND ?

                    UNION ALL

                    SELECT 'repayment', r.id, r.payment_date, r.amount,
                           CONCAT('Loan repayment from ', m.full_name), r.payment_method,
                           r.reference_number, m.full_name
                      FROM loan_repayments r JOIN members m ON r.member_id = m.id
                     WHERE r.payment_date BETWEEN ? AND ?

                    UNION ALL

                    SELECT 'welfare_in', w.id, w.contribution_date, w.amount,
                           CONCAT('Welfare contribution from ', m.full_name), w.payment_method,
                           w.reference_number, m.full_name
                      FROM welfare_contributions w JOIN members m ON w.member_id = m.id
                     WHERE w.status = 'confirmed' AND w.contribution_date BETWEEN ? AND ?

                    UNION ALL

                    SELECT 'expense', e.id, e.expense_date, e.amount,
                           COALESCE(NULLIF(e.description, ''), e.category), e.payment_method,
                           e.reference_number, NULL
                      FROM expenses e WHERE e.expense_date BETWEEN ? AND ?

                    UNION ALL

                    SELECT 'loan_disbursed', l.id, l.disbursement_date, l.principal_amount,
                           CONCAT('Loan disbursed to ', m.full_name,
                                  COALESCE(CONCAT(' for ', l.purpose), '')),
                           'mpesa_stk', NULL, m.full_name
                      FROM loans l JOIN members m ON l.member_id = m.id
                     WHERE l.disbursement_date IS NOT NULL
                       AND l.status IN ('active','disbursed','completed')
                       AND l.disbursement_date BETWEEN ? AND ?

                    UNION ALL

                    SELECT 'welfare_out', wr.id, wr.request_date, wr.amount,
                           CONCAT('Welfare paid to ', m.full_name, ': ',
                                  LEFT(COALESCE(wr.reason,''), 60)),
                           'mpesa_stk', NULL, m.full_name
                      FROM welfare_requests wr JOIN members m ON wr.member_id = m.id
                     WHERE wr.status IN ('approved','disbursed') AND wr.request_date BETWEEN ? AND ?

                    UNION ALL

                    SELECT 'other_in', le.id, le.entry_date, le.amount,
                           CONCAT('[', le.category, '] ',
                                  COALESCE(le.description, 'Other income')),
                           le.payment_method, le.reference_number, m.full_name
                      FROM ledger_entries le LEFT JOIN members m ON le.member_id = m.id
                     WHERE le.direction = 'in' AND le.entry_date BETWEEN ? AND ?

                    UNION ALL

                    SELECT 'other_out', le.id, le.entry_date, le.amount,
                           CONCAT('[', le.category, '] ',
                                  COALESCE(le.description, 'Other spending')),
                           le.payment_method, le.reference_number, m.full_name
                      FROM ledger_entries le LEFT JOIN members m ON le.member_id = m.id
                     WHERE le.direction = 'out' AND le.entry_date BETWEEN ? AND ?

                    ORDER BY entry_date DESC, source
                    SQL,
                [$from, $to, $from, $to, $from, $to, $from, $to, $from, $to, $from, $to, $from, $to, $from, $to]
            );

            $inbound = ['savings', 'repayment', 'welfare_in', 'other_in'];

            $decorated = array_map(static function (array $entry) use ($inbound): array {
                $entry['amount'] = LoanMath::round2($entry['amount']);
                $entry['direction'] = in_array($entry['source'], $inbound, true) ? 'in' : 'out';
                return $entry;
            }, $entries);

            /* ------------------------------------------------ category breakdown */

            // Only categories with something in them. An empty row reads as a
            // zero the treasurer has to think about, rather than as "nothing".
            $outByCategory = array_values(array_filter([
                ['category' => 'Loans disbursed (receivable)',
                 'total' => LoanMath::round2($loansOut['total']), 'count' => $loansOut['count']],
                ['category' => 'Operating expenses',
                 'total' => LoanMath::round2($expensesOut['total']), 'count' => $expensesOut['count']],
                ['category' => 'Welfare paid out',
                 'total' => LoanMath::round2($welfareOut['total']), 'count' => $welfareOut['count']],
                ['category' => 'Other spending',
                 'total' => LoanMath::round2($otherOut['total']), 'count' => $otherOut['count']],
            ], static fn(array $row) => $row['total'] > 0));

            $inByCategory = array_values(array_filter([
                ['category' => 'Member savings',
                 'total' => LoanMath::round2($savingsIn['total']), 'count' => $savingsIn['count']],
                ['category' => 'Loan repayments',
                 'total' => LoanMath::round2($repaymentsIn['total']), 'count' => $repaymentsIn['count']],
                ['category' => 'Welfare contributions',
                 'total' => LoanMath::round2($welfareIn['total']), 'count' => $welfareIn['count']],
                ['category' => 'Other income',
                 'total' => LoanMath::round2($otherIn['total']), 'count' => $otherIn['count']],
            ], static fn(array $row) => $row['total'] > 0));

            Response::json([
                'period' => ['from' => $from, 'to' => $to],
                'balance' => [
                    'opening' => LoanMath::round2($openingBalance),
                    'total_in' => LoanMath::round2($totalIn),
                    'total_out' => LoanMath::round2($totalOut),
                    'closing' => LoanMath::round2($closingBalance),
                ],
                'position' => [
                    'cash' => LoanMath::round2($closingBalance),
                    'receivable_from_members' => LoanMath::round2($receivable),
                    'net_worth' => LoanMath::round2($netWorth),
                    'held_for_members' => LoanMath::round2($trustLiability),
                    'savings_held' => LoanMath::round2($savingsHeld),
                    'welfare_held' => LoanMath::round2($welfareHeld - $welfarePaid),
                    'note' => 'Member savings and welfare funds are member money held on trust. '
                        . 'They are a liability, not profit.',
                ],
                'money_in' => $inByCategory,
                'money_out' => $outByCategory,
                'entries' => $decorated,
                'totals' => [
                    'entry_count' => count($decorated),

                    // What the group actually spent, as opposed to what left the
                    // bank. Loans disbursed are excluded: the money went to a
                    // member, not to the group's running costs.
                    'operating_spend_only' => LoanMath::round2(
                        $expensesOut['total'] + $otherOut['total']
                    ),
                ],
            ]);
        } catch (\Throwable $e) {
            Log::warn('getCashBook: ' . $e->getMessage());
            Response::error('Failed to build the cash book.', 500);
        }
    }

    /** Records a manual money-in or money-out entry. */
    public static function recordLedgerEntry(Request $r): void
    {
        try {
            $body = $r->body();

            $direction = $body['direction'] ?? null;
            $category = $body['category'] ?? null;
            $amount = $body['amount'] ?? null;
            $entryDate = $body['entry_date'] ?? null;

            if (!in_array($direction, ['in', 'out'], true)) {
                Response::error("Direction must be 'in' or 'out'.", 400);
            }

            if (!$category) {
                Response::error('Category is required.', 400);
            }

            // Checked as a number rather than merely truthy: the old test accepted
            // a string, and a negative amount would have drained the books.
            if ($amount === null || !is_numeric($amount) || (float) $amount <= 0) {
                Response::error('Amount must be greater than zero.', 400);
            }

            if (!$entryDate) {
                Response::error('Date is required.', 400);
            }

            $entryId = Database::insert(
                <<<'SQL'
                    INSERT INTO ledger_entries
                      (direction, category, description, amount, entry_date,
                       payment_method, reference_number, member_id, recorded_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    SQL,
                [
                    $direction,
                    $category,
                    $body['description'] ?? null,
                    $amount,
                    $entryDate,
                    $body['payment_method'] ?? 'cash',
                    $body['reference_number'] ?? null,
                    $body['member_id'] ?? null,
                    $r->user['id'],
                ]
            );

            Response::json([
                'success' => true,
                'entry_id' => $entryId,
                'message' => $direction === 'in'
                    ? 'Money received recorded.'
                    : 'Money paid out recorded.',
            ], 201);
        } catch (\Throwable $e) {
            Log::warn('recordLedgerEntry: ' . $e->getMessage());
            Response::error('Failed to record the entry.', 500);
        }
    }

    /** Deletes a ledger entry. */
    public static function deleteLedgerEntry(Request $r): void
    {
        try {
            $statement = Database::run(
                'DELETE FROM ledger_entries WHERE id = ?',
                [$r->param('id')]
            );

            // Counted rather than assumed: reporting success while deleting
            // nothing is how a row survives a delete and the books stop agreeing
            // with what is on screen.
            if ($statement->rowCount() === 0) {
                Response::error('Entry not found.', 404);
            }

            Response::json(['success' => true, 'message' => 'Entry deleted.']);
        } catch (\Throwable $e) {
            Log::warn('deleteLedgerEntry: ' . $e->getMessage());
            Response::error('Failed to delete the entry.', 500);
        }
    }
}