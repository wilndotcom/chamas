<?php

declare(strict_types=1);

/**
 * Compares this port against vectors produced by the Node implementation.
 *
 * Run:
 *   node ../backend/tests/loanMathVectors.mjs > vectors.json
 *   php tests/LoanMathVectors.php vectors.json
 *
 * The unit tests prove each side is self-consistent. This proves they agree with
 * each other, which is the property that matters: these figures go on a member's
 * balance, so a one-cent difference between backends is a real defect that no
 * individual test would catch.
 */

require __DIR__ . '/../vendor/autoload.php';

use TheTeam\Utils\LoanMath;

$path = $argv[1] ?? null;
if ($path === null || !is_file($path)) {
    fwrite(STDERR, "Usage: php tests/LoanMathVectors.php <vectors.json>\n");
    fwrite(STDERR, "Produce it with: node ../backend/tests/loanMathVectors.mjs > vectors.json\n");
    exit(2);
}

$expected = json_decode(file_get_contents($path), true);
if (!is_array($expected)) {
    fwrite(STDERR, "Could not read the vectors file. Is it valid JSON?\n");
    exit(2);
}

$passed = 0;
$failed = 0;

/**
 * Compares loosely on purpose.
 *
 * A strict === would flag 10000 against 10000.0 as a difference, which is not
 * one - JSON encodes both the same way and the frontend never sees it. What
 * must match is the number a member reads, so numbers compare numerically and
 * everything else as text.
 */
function same($a, $b): bool
{
    if (is_array($a) && is_array($b)) {
        if (array_keys($a) !== array_keys($b)) {
            return false;
        }
        foreach ($a as $key => $value) {
            if (!same($value, $b[$key])) {
                return false;
            }
        }
        return true;
    }

    if (is_bool($a) || is_bool($b)) {
        return $a === $b;
    }

    if (is_numeric($a) && is_numeric($b)) {
        // Two decimal places is the precision the app works in.
        return LoanMath::round2($a) === LoanMath::round2($b);
    }

    return $a === $b;
}

function compare(string $name, $expected, $actual): void
{
    global $passed, $failed;

    if (same($expected, $actual)) {
        $passed++;
        echo "  PASS  {$name}\n";
        return;
    }

    $failed++;
    echo "  FAIL  {$name}\n";
    echo '        node: ' . json_encode($expected) . "\n";
    echo '        php:  ' . json_encode($actual) . "\n";
}

echo "\nComparing against the Node implementation\n";

echo "\n--- round2 ---\n";
$inputs = [10.005, 10.004, 10, 0, 'abc', null, -10.005, -10.004, 1.005, 2.675, 1.115, 1234.5678];
foreach ($expected['round2'] as $i => $value) {
    compare('round2(' . var_export($inputs[$i], true) . ')', $value, LoanMath::round2($inputs[$i]));
}

echo "\n--- dateOnly ---\n";
$dates = ['2026-01-15', '2026-03-09', null, 'not-a-date', '', '2026-06-30'];
foreach ($expected['dateOnly'] as $i => $value) {
    compare('dateOnly(' . var_export($dates[$i], true) . ')', $value, LoanMath::dateOnly($dates[$i]));
}

echo "\n--- decorateLoan ---\n";
$loans = json_decode(file_get_contents($path), true); // re-read for the raw inputs
$rawLoans = [
    ['principal_amount' => 10000, 'interest_amount' => 1000, 'total_repayable' => 11000, 'amount_paid' => 0, 'balance' => 11000, 'status' => 'active'],
    ['principal_amount' => 10000, 'interest_amount' => 1000, 'total_repayable' => 11000, 'amount_paid' => 5500, 'balance' => 5500, 'status' => 'active'],
    ['principal_amount' => 10000, 'interest_amount' => 1000, 'total_repayable' => 11000, 'amount_paid' => 11000, 'balance' => 0, 'status' => 'completed'],
    ['principal_amount' => 5000, 'interest_amount' => 0, 'total_repayable' => 5000, 'amount_paid' => 1250, 'balance' => 3750, 'status' => 'disbursed'],
    ['principal_amount' => '10000.00', 'interest_amount' => '1000.00', 'total_repayable' => '11000.00', 'amount_paid' => '5500.00', 'balance' => '5500.00', 'status' => 'active'],
    ['principal_amount' => 3333.33, 'interest_amount' => 333.33, 'total_repayable' => 3666.66, 'amount_paid' => 111.11, 'balance' => 3555.55, 'status' => 'active'],
    ['principal_amount' => 100, 'interest_amount' => 5, 'total_repayable' => 105, 'amount_paid' => 104, 'balance' => 1, 'status' => 'active'],
    ['principal_amount' => 0, 'interest_amount' => 0, 'total_repayable' => 0, 'amount_paid' => 0, 'balance' => 0, 'status' => 'active'],
    ['principal_amount' => 20000, 'interest_amount' => 2000, 'total_repayable' => 22000, 'amount_paid' => 22000, 'balance' => 0, 'status' => 'active'],
    ['principal_amount' => 750, 'interest_amount' => 75, 'total_repayable' => 825, 'amount_paid' => 0, 'balance' => 825, 'status' => 'pending'],
];
foreach ($expected['decorate'] as $i => $value) {
    compare("decorateLoan[{$i}] ({$rawLoans[$i]['status']})", $value, LoanMath::decorateLoan($rawLoans[$i]));
}

echo "\n--- summarise ---\n";
$summaries = [
    [],
    [
        ['is_open' => true, 'balance' => 11000, 'interest_outstanding' => 1000, 'total_repayable' => 11000, 'amount_paid' => 0],
        ['is_open' => true, 'balance' => 3000, 'interest_outstanding' => 500, 'total_repayable' => 5500, 'amount_paid' => 2500],
    ],
];
foreach ($expected['summarise'] as $i => $value) {
    $actual = $i === 2
        ? LoanMath::summarise(array_map([LoanMath::class, 'decorateLoan'], $rawLoans))
        : LoanMath::summarise($summaries[$i]);
    compare("summarise[{$i}]", $value, $actual);
}

echo "\npassed {$passed}, failed {$failed}\n";

if ($failed > 0) {
    echo "\nA difference here means the same loan reports different figures\n";
    echo "depending on which backend answers.\n";
    exit(1);
}