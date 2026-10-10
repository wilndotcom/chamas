<?php

declare(strict_types=1);

/**
 * The Node loan tests, ported case for case.
 *
 * These are the same assertions as backend/tests/loanMath.test.js, kept in step
 * deliberately. They cover the interest calculation, rounding and date handling
 * that every member's balance depends on - a silent difference between the two
 * backends means the same loan reports a different balance depending on which
 * server answers, and nothing else in the system would notice.
 *
 * Run:  php tests/LoanMathTest.php
 */

require __DIR__ . '/../vendor/autoload.php';

use TheTeam\Utils\LoanMath;

$passed = 0;
$failed = 0;
$failures = [];

function check(string $name, $expected, $actual): void
{
    global $passed, $failed, $failures;

    // Compared as strings so 10.00 and 10 are treated as equal. JSON encodes both
    // the same way, and the frontend never sees the difference.
    if ((string) $expected === (string) $actual) {
        $passed++;
        echo "  PASS  {$name}\n";
        return;
    }

    $failed++;
    $failures[] = $name;
    echo "  FAIL  {$name}\n";
    echo '        expected ' . var_export($expected, true)
        . ', got ' . var_export($actual, true) . "\n";
}

echo "\n--- round2 ---\n";

check('round2 rounds to two decimal places', 10.01, LoanMath::round2(10.005));
check('round2 rounds down below the half', 10.0, LoanMath::round2(10.004));
check('round2 leaves whole numbers alone', 10, LoanMath::round2(10));
check('round2 leaves zero alone', 0, LoanMath::round2(0));

// A NaN from a corrupted balance must not propagate through the app.
check('round2 treats a non-number as zero', 0, LoanMath::round2('abc'));
check('round2 treats null as zero', 0, LoanMath::round2(null));

check('round2 handles negative amounts', -10.01, LoanMath::round2(-10.005));
check('round2 handles small negative amounts', -10.0, LoanMath::round2(-10.004));

echo "\n--- dateOnly ---\n";

// A date at midnight local time must not become the previous day.
check(
    'dateOnly keeps the local calendar date',
    '2026-01-15',
    LoanMath::dateOnly(new DateTimeImmutable('2026-01-15 00:00:00'))
);

check('dateOnly passes a valid string through', '2026-03-09', LoanMath::dateOnly('2026-03-09'));

check('dateOnly returns null for null', null, LoanMath::dateOnly(null));
check('dateOnly returns null for nonsense', null, LoanMath::dateOnly('not-a-date'));
check('dateOnly returns null for an empty string', null, LoanMath::dateOnly(''));

echo "\n--- decorateLoan ---\n";

$loan = LoanMath::decorateLoan([
    'principal_amount' => 10000,
    'interest_amount' => 1000,
    'total_repayable' => 11000,
    'amount_paid' => 0,
    'balance' => 11000,
    'status' => 'active',
]);
check('decorateLoan keeps the principal', 10000, $loan['principal_amount']);
check('decorateLoan keeps the interest', 1000, $loan['interest_amount']);
check('decorateLoan keeps the total repayable', 11000, $loan['total_repayable']);
check('decorateLoan keeps the balance', 11000, $loan['balance']);
check('decorateLoan computes flat interest', 1000, $loan['interest_outstanding']);

// Half the balance remains, so half the interest remains outstanding.
$loan = LoanMath::decorateLoan([
    'principal_amount' => 10000,
    'interest_amount' => 1000,
    'total_repayable' => 11000,
    'amount_paid' => 5500,
    'balance' => 5500,
    'status' => 'active',
]);
check('decorateLoan derives interest pro rata', 500, $loan['interest_outstanding']);

$loan = LoanMath::decorateLoan([
    'principal_amount' => 10000,
    'interest_amount' => 1000,
    'total_repayable' => 11000,
    'amount_paid' => 11000,
    'balance' => 0,
    'status' => 'active',
]);
check('decorateLoan returns zero interest when repaid', 0, $loan['interest_outstanding']);

$loan = LoanMath::decorateLoan([
    'principal_amount' => 10000,
    'interest_amount' => 1000,
    'total_repayable' => 11000,
    'amount_paid' => 11000,
    'balance' => 0,
    'status' => 'completed',
]);
check('decorateLoan marks a settled loan', true, $loan['is_settled']);
check('decorateLoan zeroes interest on a settled loan', 0, $loan['interest_outstanding']);
check('decorateLoan zeroes principal on a settled loan', 0, $loan['principal_outstanding']);

$loan = LoanMath::decorateLoan([
    'principal_amount' => 5000,
    'interest_amount' => 0,
    'total_repayable' => 5000,
    'amount_paid' => 0,
    'balance' => 5000,
    'status' => 'active',
]);
check('decorateLoan handles a zero interest rate', 0, $loan['interest_outstanding']);
check('decorateLoan keeps the total with zero interest', 5000, $loan['total_repayable']);

$loan = LoanMath::decorateLoan([
    'principal_amount' => 10000,
    'interest_amount' => 1000,
    'total_repayable' => 11000,
    'amount_paid' => 5500,
    'balance' => 5500,
    'status' => 'active',
]);
check('decorateLoan computes the repaid percentage', 50, $loan['repaid_percent']);

echo "\n--- edge cases the Node tests do not cover ---\n";

// A total of zero would divide by zero. Guarded rather than allowed to produce
// a NAN that JSON cannot even represent.
$loan = LoanMath::decorateLoan([
    'principal_amount' => 0,
    'interest_amount' => 0,
    'total_repayable' => 0,
    'amount_paid' => 0,
    'balance' => 0,
    'status' => 'active',
]);
check('decorateLoan survives a zero total', 0, $loan['interest_outstanding']);
check('decorateLoan reports 0% repaid on a zero loan', 0, $loan['repaid_percent']);

// DECIMAL columns arrive as strings from MySQL. Without coercion PHP would
// concatenate them and produce figures like "100001000".
$loan = LoanMath::decorateLoan([
    'principal_amount' => '10000.00',
    'interest_amount' => '1000.00',
    'total_repayable' => '11000.00',
    'amount_paid' => '5500.00',
    'balance' => '5500.00',
    'status' => 'active',
]);
check('decorateLoan coerces string amounts', 5500, $loan['balance']);
check('decorateLoan computes interest from strings', 500, $loan['interest_outstanding']);

// Principal outstanding must never go negative: rounding can leave the interest
// marginally above the balance, and a negative figure reads as money owed back.
$loan = LoanMath::decorateLoan([
    'principal_amount' => 100,
    'interest_amount' => 5,
    'total_repayable' => 105,
    'amount_paid' => 104,
    'balance' => 1,
    'status' => 'active',
]);
check('decorateLoan never reports negative principal', true, $loan['principal_outstanding'] >= 0);

echo "\n--- summarise ---\n";

$summary = LoanMath::summarise([
    ['is_open' => true, 'balance' => 11000, 'interest_outstanding' => 1000, 'total_repayable' => 11000, 'amount_paid' => 0],
    ['is_open' => true, 'balance' => 3000, 'interest_outstanding' => 500, 'total_repayable' => 5500, 'amount_paid' => 2500],
]);
check('summarise totals the balance', 14000, $summary['total_balance']);
check('summarise totals the repayable', 16500, $summary['total_repayable']);
check('summarise totals the amount paid', 2500, $summary['amount_paid']);
check('summarise counts the open loans', 2, $summary['open_loan_count']);

$summary = LoanMath::summarise([]);
check('summarise handles an empty list', 0, $summary['total_balance']);
check('summarise reports no repayable for an empty list', 0, $summary['total_repayable']);
check('summarise counts no open loans', 0, $summary['open_loan_count']);

$summary = LoanMath::summarise([
    ['is_open' => true, 'is_settled' => false, 'balance' => 1100, 'interest_outstanding' => 100, 'total_repayable' => 1100, 'amount_paid' => 0],
    ['is_open' => true, 'is_settled' => false, 'balance' => 2200, 'interest_outstanding' => 200, 'total_repayable' => 2200, 'amount_paid' => 0],
    ['is_open' => false, 'is_settled' => true, 'balance' => 0, 'interest_outstanding' => 0, 'total_repayable' => 3300, 'amount_paid' => 3300],
]);
check('summarise counts open loans', 2, $summary['open_loan_count']);
check('summarise counts settled loans', 1, $summary['settled_loan_count']);
// A settled loan's money must not inflate the open totals.
check('summarise excludes a settled balance', 3300, $summary['total_balance']);

$summary = LoanMath::summarise([
    ['is_open' => true, 'balance' => 5500, 'interest_outstanding' => 500, 'total_repayable' => 11000, 'amount_paid' => 5500],
]);
check('summarise computes the repaid percentage', 50, $summary['repaid_percent']);

echo "\npassed {$passed}, failed {$failed}\n";

if ($failed > 0) {
    echo "\nfailures:\n";
    foreach ($failures as $failure) {
        echo "  - {$failure}\n";
    }
    exit(1);
}