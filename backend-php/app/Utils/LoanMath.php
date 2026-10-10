<?php

declare(strict_types=1);

namespace TheTeam\Utils;

/**
 * Loan arithmetic shared by the member portal, the dashboard and reports.
 *
 * Flat-interest chama loans charge one interest figure on the principal for the
 * whole term. Repayments arrive as single amounts with no split recorded, so the
 * interest still outstanding is derived pro rata: the remaining balance keeps
 * the same share of interest it had when the loan was written.
 *
 *     interest_outstanding = balance / total_repayable * interest_charged
 *
 * It is an estimate, and is labelled as one in the UI rather than presented as
 * a separate ledger, because the system does not record which part of each
 * repayment cleared interest.
 *
 * A direct port of backend/utils/loanMath.js, including its rounding and its
 * treatment of a zero total. Both matter: a total_repayable of 0 would divide by
 * zero, and a member seeing a nan on their balance would have no way to tell
 * whether the app was broken or they were.
 */
final class LoanMath
{
    /**
     * Two decimal places, matching JavaScript's Math.round exactly.
     *
     * This cannot be PHP's round(). The two disagree on exact halves: PHP
     * round() applies a representation-correction step that Math.round does
     * not, so round2(1.005) is 1.01 here and 1 in the Node version. The
     * difference is one cent, on a figure a member compares against their own
     * record, and it would appear only after switching backends - the worst
     * time to discover it.
     *
     * Math.round is "half toward positive infinity", which floor(x + 0.5)
     * reproduces. The values it settles are identical to Node's across the test
     * vectors, including the awkward ones (2.675, 1.115, negative halves).
     *
     * Verified against vectors produced by the Node implementation; see
     * tests/LoanMathVectors.php. Do not "simplify" this to round().
     */
    public static function round2($n): float
    {
        $value = is_numeric($n) ? (float) $n : 0.0;

        // Not is_nan() guarded: is_numeric already rejected anything
        // non-numeric, and a NaN would propagate through the whole loan
        // calculation rather than being caught at the end.
        if (!is_finite($value)) {
            return 0.0;
        }

        return floor($value * 100 + 0.5) / 100;
    }

    /**
     * Normalises a date column to a plain YYYY-MM-DD string.
     *
     * MySQL DATE and DATETIME columns arrive as strings through PDO, so the
     * string branch handles them. The Date branch exists because a caller may
     * pass one, and the local-components formatting is deliberate: converting to
     * UTC first would shift the day for anybody east or west of UTC.
     */
    public static function dateOnly($value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }

        if ($value instanceof \DateTimeInterface) {
            return $value->format('Y-m-d');
        }

        $text = substr((string) $value, 0, 10);

        return preg_match('/^\d{4}-\d{2}-\d{2}$/', $text) === 1 ? $text : null;
    }

    /**
     * Adds the interest/principal breakdown to a loan row.
     *
     * Returns a new array with the original fields plus the derived ones. The
     * amounts are coerced to floats, because MySQL DECIMAL arrives as a string
     * and JavaScript silently multiplied it as a number - PHP would not, and
     * would concatenate instead if the coercion were missed.
     */
    public static function decorateLoan(array $row): array
    {
        $principal = (float) ($row['principal_amount'] ?? 0);
        $interest = (float) ($row['interest_amount'] ?? 0);
        $total = (float) ($row['total_repayable'] ?? 0);
        $paid = (float) ($row['amount_paid'] ?? 0);
        $balance = (float) ($row['balance'] ?? 0);

        // A total of 0 would divide by zero. The guard also covers loans with no
        // terms recorded, where the ratio has no meaning and 0 is the honest
        // answer rather than a division error.
        $interestOutstanding = $total > 0
            ? self::round2(($balance / $total) * $interest)
            : 0.0;

        // Clamped at zero: rounding can leave the interest marginally above the
        // balance, and a negative "principal outstanding" on a loan would read
        // to a member as money owed to them.
        $principalOutstanding = self::round2(max(0.0, $balance - $interestOutstanding));
        $repaidPct = $total > 0 ? min(100.0, self::round2(($paid / $total) * 100)) : 0.0;

        $status = (string) ($row['status'] ?? '');
        $open = in_array($status, ['approved', 'active', 'disbursed'], true);
        $settled = $status === 'completed';

        $dueDate = self::dateOnly($row['due_date'] ?? null);

        $daysToDue = null;
        if ($dueDate !== null) {
            $due = \DateTimeImmutable::createFromFormat('!Y-m-d', $dueDate);
            if ($due !== false) {
                // Midnight today, so a loan due today reads as 0 rather than
                // rounding to 1 or -1 depending on the time of day the member
                // happened to look.
                $today = new \DateTimeImmutable('today');
                $daysToDue = (int) round(($due->getTimestamp() - $today->getTimestamp()) / 86400);
            }
        }

        return array_merge($row, [
            'application_date' => self::dateOnly($row['application_date'] ?? null),
            'approval_date' => self::dateOnly($row['approval_date'] ?? null),
            'disbursement_date' => self::dateOnly($row['disbursement_date'] ?? null),
            'due_date' => $dueDate,

            'principal_amount' => self::round2($principal),
            'interest_amount' => self::round2($interest),
            'total_repayable' => self::round2($total),
            'amount_paid' => self::round2($paid),
            'balance' => self::round2($balance),

            // A settled loan owes nothing, whatever the stored balance says. The
            // derived figures follow the status rather than the numbers, because
            // a completed loan showing a residual balance would invite a member
            // to argue with the system about money they no longer owe.
            'interest_outstanding' => $settled ? 0.0 : $interestOutstanding,
            'principal_outstanding' => $settled ? 0.0 : $principalOutstanding,
            'repaid_percent' => $settled ? 100.0 : $repaidPct,

            'is_open' => $open,
            'is_settled' => $settled,
            'days_to_due' => $daysToDue,
            'is_overdue' => $open && $daysToDue !== null && $daysToDue < 0,
        ]);
    }

    /** Totals across several loans, for the member dashboard summary. */
    public static function summarise(array $loans): array
    {
        $all = $loans ?? [];

        $open = array_values(array_filter(
            $all,
            static fn($loan) => !empty($loan['is_open'])
        ));

        $sum = static function (string $key) use ($open): float {
            $total = 0.0;
            foreach ($open as $loan) {
                $total += (float) ($loan[$key] ?? 0);
            }
            return LoanMath::round2($total);
        };

        $settledCount = count(array_filter(
            $all,
            static fn($loan) => !empty($loan['is_settled'])
        ));

        $totalRepayable = self::round2(array_sum(array_map(
            static fn($l) => (float) ($l['total_repayable'] ?? 0),
            $open
        )));

        $amountPaid = self::round2(array_sum(array_map(
            static fn($l) => (float) ($l['amount_paid'] ?? 0),
            $open
        )));

        // Nearest due date across open loans, so the member sees one clear
        // deadline rather than a list they have to compare themselves.
        $daysToDue = null;
        $nextDueDate = null;

        foreach ($open as $loan) {
            $days = $loan['days_to_due'] ?? null;
            if ($days !== null && ($daysToDue === null || $days < $daysToDue)) {
                $daysToDue = $days;
            }

            $due = $loan['due_date'] ?? null;
            if ($due !== null && ($nextDueDate === null || strcmp((string) $due, $nextDueDate) < 0)) {
                $nextDueDate = $due;
            }
        }

        return [
            'open_loan_count' => count($open),
            'settled_loan_count' => $settledCount,
            'total_balance' => $sum('balance'),
            'principal_outstanding' => $sum('principal_outstanding'),
            'interest_outstanding' => $sum('interest_outstanding'),
            'amount_paid' => $amountPaid,
            'total_repayable' => $totalRepayable,
            'repaid_percent' => $totalRepayable > 0
                ? min(100.0, self::round2(($amountPaid / $totalRepayable) * 100))
                : 0.0,
            'next_due_date' => $nextDueDate,
            'days_to_due' => $daysToDue,
            'is_overdue' => $daysToDue !== null && $daysToDue < 0,
        ];
    }
}