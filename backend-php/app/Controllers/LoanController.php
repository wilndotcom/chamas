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
 * Loans: applying, approving, disbursing and repaying.
 *
 * A port of backend/controllers/loanController.js.
 *
 * Loan interest rule
 * ------------------
 * Chama interest is FLAT and charged once on the principal for the whole term.
 * It is not a reducing balance, and it is not compounded on what is still owed:
 *
 *     interest  = principal * rate / 100
 *     repayable = principal + interest      <- the member repays this in full
 *
 * A 1,000 loan at 10% is repayable at 1,100 - never 1,105, 1,110.50 and so on.
 * The rate is copied onto the loan row when the member applies, so raising the
 * default later never changes the price of a loan already taken.
 */
final class LoanController
{
    private const MAX_RATE = 100;
    private const MAX_DURATION_MONTHS = 60;

    /**
     * Validates a rate as a percentage. Null when it is not usable.
     *
     * A rate of zero is allowed: an interest-free loan is a real thing for a
     * committee to approve, and rejecting it would leave no way to express one.
     */
    public static function parseRate($value): ?float
    {
        if ($value === null || $value === '') {
            return null;
        }

        if (!is_numeric($value)) {
            return null;
        }

        $rate = (float) $value;

        if (!is_finite($rate) || $rate < 0 || $rate > self::MAX_RATE) {
            return null;
        }

        return LoanMath::round2($rate);
    }

    /** Validates a term in whole months. Null when it is not usable. */
    public static function parseDuration($value): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }

        if (!is_numeric($value)) {
            return null;
        }

        $months = (float) $value;

        if (!is_finite($months) || $months < 1 || $months > self::MAX_DURATION_MONTHS) {
            return null;
        }

        // Rounded rather than floored, so a 2.6-month term is offered as 3
        // months. Flooring would silently shorten every term somebody entered as
        // a decimal.
        return (int) round($months);
    }

    // ---------------------------------------------------------------- reads

    /** Every loan, newest first. */
    public static function getAllLoans(Request $r): void
    {
        try {
            $loans = Database::all(
                <<<'SQL'
                    SELECT l.*, m.full_name AS member_name, a.full_name AS approved_by_name
                      FROM loans l
                      JOIN members m ON l.member_id = m.id
                      LEFT JOIN admins a ON l.approved_by = a.id
                     ORDER BY l.created_at DESC
                    SQL
            );

            Response::json(['loans' => $loans]);
        } catch (\Throwable $e) {
            Log::warn('getAllLoans: ' . $e->getMessage());
            Response::error('Failed to fetch loans.', 500);
        }
    }

    /**
     * A member's own loans.
     *
     * Scoped to the token's member. Members cannot list anybody else's.
     */
    public static function getMyLoans(Request $r): void
    {
        try {
            $memberId = $r->user['id'];

            $rows = Database::all(
                <<<'SQL'
                    SELECT id, principal_amount, interest_rate, interest_amount, total_repayable,
                           amount_paid, balance, status, purpose, application_date, approval_date,
                           disbursement_date, due_date
                      FROM loans WHERE member_id = ?
                     ORDER BY application_date DESC
                    SQL,
                [$memberId]
            );

            $repayments = Database::all(
                <<<'SQL'
                    SELECT id, loan_id, amount, payment_date, payment_method
                      FROM loan_repayments WHERE member_id = ?
                     ORDER BY payment_date DESC LIMIT 50
                    SQL,
                [$memberId]
            );

            // The interest/principal breakdown, so members see what they owe.
            $loans = array_map([LoanMath::class, 'decorateLoan'], $rows);

            Response::json([
                'loans' => $loans,
                'repayments' => $repayments,
                'summary' => LoanMath::summarise($loans),
            ]);
        } catch (\Throwable $e) {
            Log::warn('getMyLoans: ' . $e->getMessage());
            Response::error('Failed to load your loans.', 500);
        }
    }

    /** Applications waiting for a decision. */
    public static function getPendingLoans(Request $r): void
    {
        try {
            $loans = Database::all(
                <<<'SQL'
                    SELECT l.*, m.full_name AS member_name, m.phone AS member_phone
                      FROM loans l JOIN members m ON l.member_id = m.id
                     WHERE l.status = 'pending' ORDER BY l.application_date ASC
                    SQL
            );

            Response::json(['loans' => $loans]);
        } catch (\Throwable $e) {
            Log::warn('getPendingLoans: ' . $e->getMessage());
            Response::error('Failed to fetch pending loans.', 500);
        }
    }

    // ---------------------------------------------------------------- writes

    /** A member applies for a loan. */
    public static function applyForLoan(Request $r): void
    {
        try {
            $body = $r->body();
            $memberId = $r->user['id'];

            $principal = LoanMath::round2($body['principal_amount'] ?? null);

            if ($principal <= 0) {
                Response::error('Enter a loan amount greater than zero.', 400);
            }

            // The rate is snapshotted onto the loan now. Changing the default in
            // settings afterwards must not reprice a loan already applied for.
            $rate = self::parseRate(Settings::get('loan_interest_rate', '10')) ?? 10.0;
            $interestAmount = LoanMath::round2(($principal * $rate) / 100);
            $totalRepayable = LoanMath::round2($principal + $interestAmount);

            $loanId = Database::insert(
                <<<'SQL'
                    INSERT INTO loans
                      (member_id, principal_amount, interest_rate, interest_amount,
                       total_repayable, balance, purpose, application_date)
                    VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE())
                    SQL,
                [$memberId, $principal, $rate, $interestAmount, $totalRepayable, $totalRepayable, $body['purpose'] ?? null]
            );

            Response::json([
                'success' => true,
                'loan_id' => $loanId,
                'interest_rate' => $rate,
                'interest_amount' => $interestAmount,
                'total_repayable' => $totalRepayable,
                'message' => 'Loan application submitted.',
            ], 201);
        } catch (\Throwable $e) {
            // Logged so a 500 is diagnosable rather than a silent shrug.
            Log::warn('[loans] apply failed: ' . $e->getMessage());
            Response::error('Failed to apply for loan.', 500);
        }
    }

    /** Approves an application and fixes its price and due date. */
    public static function approveLoan(Request $r): void
    {
        try {
            $id = $r->param('id');
            $body = $r->body();

            $loan = Database::one(
                <<<'SQL'
                    SELECT l.*, m.full_name AS member_name
                      FROM loans l JOIN members m ON m.id = l.member_id
                     WHERE l.id = ?
                    SQL,
                [$id]
            );

            if ($loan === null) {
                Response::error('Loan not found.', 404);
            }

            if ($loan['status'] !== 'pending') {
                // Named rather than a generic conflict, because the admin needs
                // to know the loan was already dealt with - re-approving would
                // silently reprice a loan the member is already paying.
                Response::error(sprintf('This loan was already %s.', $loan['status']), 400);
            }

            // An explicit rate overrides the snapshot; otherwise the member keeps
            // the price they applied at.
            $requestedRate = self::parseRate($body['interest_rate'] ?? null);

            // Only validated when the field was actually sent. Absent means "use
            // the member's rate", which is different from sending nothing.
            if (array_key_exists('interest_rate', $body) && $body['interest_rate'] !== null
                && $requestedRate === null) {
                Response::error(
                    sprintf('Interest rate must be between 0 and %d%%.', self::MAX_RATE),
                    400
                );
            }

            $rate = $requestedRate ?? self::parseRate($loan['interest_rate']) ?? 10.0;

            $requestedMonths = self::parseDuration($body['duration_months'] ?? null);

            if (array_key_exists('duration_months', $body) && $body['duration_months'] !== null
                && $requestedMonths === null) {
                Response::error(sprintf(
                    'Loan duration must be between 1 and %d months.',
                    self::MAX_DURATION_MONTHS
                ), 400);
            }

            // Falls back to the configured default term, not a hardcoded 3.
            $durationMonths = $requestedMonths
                ?? self::parseDuration(Settings::get('loan_duration_months', '3'))
                ?? 3;

            $interestAmount = LoanMath::round2(((float) $loan['principal_amount'] * $rate) / 100);
            $totalRepayable = LoanMath::round2((float) $loan['principal_amount'] + $interestAmount);

            $dueDate = new \DateTimeImmutable('today');
            $dueDate = $dueDate->modify('+' . $durationMonths . ' months');

            Database::run(
                <<<'SQL'
                    UPDATE loans
                       SET status = 'approved',
                           interest_rate = ?,
                           interest_amount = ?,
                           total_repayable = ?,
                           balance = ?,
                           approval_date = CURDATE(),
                           due_date = ?,
                           approved_by = ?
                     WHERE id = ?
                    SQL,
                [$rate, $interestAmount, $totalRepayable, $totalRepayable, $dueDate->format('Y-m-d'), $r->user['id'], $id]
            );

            Response::json([
                'success' => true,
                'interest_rate' => $rate,
                'interest_amount' => $interestAmount,
                'total_repayable' => $totalRepayable,
                'duration_months' => $durationMonths,
                'due_date' => LoanMath::dateOnly($dueDate),
                'message' => 'Loan approved successfully.',
            ]);
        } catch (\Throwable $e) {
            Log::warn('[loans] approve failed: ' . $e->getMessage());
            Response::error('Failed to approve loan.', 500);
        }
    }

    /**
     * Marks an approved loan as paid out.
     *
     * Separate from approval because approval is a decision and disbursement is
     * the money moving. Combining them made an approved loan look paid while the
     * cash was still in the fund.
     */
    public static function disburseLoan(Request $r): void
    {
        try {
            $id = $r->param('id');

            Database::run(
                "UPDATE loans SET status = 'active', disbursement_date = CURDATE() WHERE id = ?",
                [$id]
            );

            Response::json(['success' => true, 'message' => 'Loan disbursed successfully.']);
        } catch (\Throwable $e) {
            Log::warn('[loans] disburse failed: ' . $e->getMessage());
            Response::error('Failed to disburse loan.', 500);
        }
    }

    /** Records a repayment on a member's behalf. */
    public static function recordRepayment(Request $r): void
    {
        try {
            $body = $r->body();
            $loanId = $body['loan_id'] ?? null;

            $loan = Database::one('SELECT * FROM loans WHERE id = ?', [$loanId]);

            if ($loan === null) {
                Response::error('Loan not found.', 404);
            }

            $result = Database::transaction(function ($pdo) use ($loan, $body, $r) {
                return self::applyRepayment($pdo, $loan, [
                    'amount' => $body['amount'] ?? null,
                    'paymentMethod' => $body['payment_method'] ?? null,
                    'reference' => $body['reference_number'] ?? null,
                    'remarks' => $body['remarks'] ?? null,
                    'recordedBy' => $r->user['id'],
                ]);
            });

            if (empty($result['ok'])) {
                Response::error($result['error'], $result['status']);
            }

            Response::json([
                'success' => true,
                'message' => $result['cleared']
                    ? 'Repayment recorded. This loan is now fully repaid.'
                    : 'Repayment recorded successfully.',
                'new_balance' => $result['balance_after'],
                'amount_paid' => $result['amount_paid'],
                'cleared' => $result['cleared'],
                'interest_outstanding' => $result['interest_outstanding'],
            ]);
        } catch (\Throwable $e) {
            Log::warn('[loans] repayment failed: ' . $e->getMessage());
            Response::error('Failed to record repayment. Nothing was changed.', 500);
        }
    }

    /**
     * A member repaying their own loan, in full or in part.
     *
     * Member-scoped: the loan id comes from the path, not the body, so there is
     * nothing to tamper with. Ownership is re-checked here rather than trusted
     * from the row, because an admin token and a member token must not be
     * interchangeable on this route.
     */
    public static function repayMyLoan(Request $r): void
    {
        try {
            $id = $r->param('id');
            $body = $r->body();

            $loan = Database::one(
                'SELECT * FROM loans WHERE id = ? AND member_id = ?',
                [$id, $r->user['id']]
            );

            if ($loan === null) {
                // The same response as a genuinely missing loan, so this cannot be
                // used to discover whether somebody else's loan id exists.
                Response::error('Loan not found.', 404);
            }

            $result = Database::transaction(function ($pdo) use ($loan, $body) {
                return self::applyRepayment($pdo, $loan, [
                    'amount' => $body['amount'] ?? null,
                    'paymentMethod' => $body['payment_method'] ?? null,
                    'reference' => $body['reference_number'] ?? null,
                    'remarks' => $body['remarks'] ?? null,
                    // recorded_by stays NULL: nobody on the admin side entered this.
                    'recordedBy' => null,
                ]);
            });

            if (empty($result['ok'])) {
                Response::error($result['error'], $result['status']);
            }

            Response::json([
                'success' => true,
                'message' => $result['cleared']
                    ? 'Payment received in full. This loan is now closed.'
                    : 'Payment received. Thank you.',
                'balance_before' => $result['balance_before'],
                'balance_after' => $result['balance_after'],
                'amount_paid' => $result['amount_paid'],
                'total_repayable' => $result['total_repayable'],
                'cleared' => $result['cleared'],
                'interest_outstanding' => $result['interest_outstanding'],
            ]);
        } catch (\Throwable $e) {
            Log::warn('[loans] member repayment failed: ' . $e->getMessage());
            Response::error('Could not record your payment. Nothing was changed.', 500);
        }
    }

    // ---------------------------------------------------------------- helpers

    /**
     * Applies one repayment to a loan.
     *
     * Shared by the admin route and the member self-service route so both
     * enforce exactly the same rules. Both write the loan and the repayment row
     * inside one transaction: a repayment row without the updated balance would
     * show cash received that the loan still says is owed.
     *
     *   ok = false  -> nothing was written
     *   ok = true   -> the loan and the repayment row were written together
     *
     * The guards matter more than they look. This once accepted a negative
     * amount, which *increased* the balance, and accepted any amount at all,
     * which could push amount_paid far beyond total_repayable and corrupt the
     * profit figures that sum loan totals.
     */
    private static function applyRepayment(\PDO $pdo, array $loan, array $input): array
    {
        $balance = LoanMath::round2($loan['balance']);
        $total = LoanMath::round2($loan['total_repayable']);

        $raw = $input['amount'] ?? null;
        $value = ($raw === null || !is_numeric($raw)) ? null : LoanMath::round2($raw);

        if ($value === null || !is_finite($value)) {
            return ['ok' => false, 'status' => 400, 'error' => 'Enter a repayment amount.'];
        }

        if ($value <= 0) {
            return ['ok' => false, 'status' => 400, 'error' => 'Repayment must be greater than zero.'];
        }

        if ($balance <= 0) {
            return ['ok' => false, 'status' => 400, 'error' => 'This loan is already fully repaid.'];
        }

        if (!in_array($loan['status'], ['approved', 'active', 'disbursed'], true)) {
            return [
                'ok' => false,
                'status' => 400,
                'error' => sprintf('A loan that is %s cannot take a repayment.', $loan['status']),
            ];
        }

        if ($value > $balance) {
            // Naming the maximum is more useful than "invalid amount": the member
            // is on their phone trying to clear a loan and needs to know what is
            // actually payable.
            return [
                'ok' => false,
                'status' => 400,
                'error' => sprintf(
                    'That is more than the balance. The most you can pay now is %.2f.',
                    $balance
                ),
            ];
        }

        $newBalance = LoanMath::round2($balance - $value);
        $clears = $newBalance <= 0;

        // amount_paid is derived, never incremented blindly, so it can never
        // drift past total_repayable.
        $newPaid = LoanMath::round2(min($total, LoanMath::round2($loan['amount_paid']) + $value));

        $update = $pdo->prepare(
            'UPDATE loans SET balance = ?, amount_paid = ?, status = ? WHERE id = ?'
        );
        $update->execute([$newBalance, $newPaid, $clears ? 'completed' : $loan['status'], $loan['id']]);

        $insert = $pdo->prepare(
            <<<'SQL'
                INSERT INTO loan_repayments
                  (loan_id, member_id, amount, payment_date, payment_method,
                   reference_number, remarks, recorded_by)
                VALUES (?, ?, ?, CURDATE(), ?, ?, ?, ?)
                SQL
        );
        $insert->execute([
            $loan['id'],
            $loan['member_id'],
            $value,
            $input['paymentMethod'] ?: 'cash',
            $input['reference'] ?: null,
            $input['remarks'] ?: null,
            // Distinguishes "nobody entered this" from "an admin entered it".
            $input['recordedBy'] ?? null,
        ]);

        return [
            'ok' => true,
            'loan_id' => $loan['id'],
            'amount' => $value,
            'balance_before' => $balance,
            'balance_after' => $newBalance,
            'amount_paid' => $newPaid,
            'total_repayable' => $total,
            'cleared' => $clears,
            'interest_outstanding' => LoanMath::round2(
                $newBalance > 0 && $total > 0
                    ? ($newBalance / $total) * (float) $loan['interest_amount']
                    : 0.0
            ),
        ];
    }
}