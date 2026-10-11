<?php

declare(strict_types=1);

/**
 * Every format a Kenyan number reaches this app in.
 *
 * Run: php backend-php/tests/PhoneTest.php
 *
 * Written as a plain table rather than a framework because the whole point is
 * the table itself: the formats are the requirement, and a failure has to name
 * the format that broke.
 */

require __DIR__ . '/../vendor/autoload.php';

use TheTeam\Utils\Phone;

$pass = 0;
$fail = 0;

/** @var array<int, array{0:string,1:?string,2:string}> */
$formats = [
    // What a member would type, in every shape it arrives in.
    ['0712345678', '254712345678', 'local, as stored'],
    ['254712345678', '254712345678', 'already international'],
    ['+254712345678', '254712345678', 'the plus sign used on M-Pesa confirmations'],
    ['00254712345678', '254712345678', 'the 00 dialling prefix'],
    ['712345678', '254712345678', 'local without the leading zero'],
    ['0712 345 678', '254712345678', 'spaced in threes, off a till receipt'],
    ['+254 712 345 678', '254712345678', 'spaced with a plus'],
    ['+254-712-345-678', '254712345678', 'hyphenated'],
    ['(0712) 345-678', '254712345678', 'bracketed and hyphenated'],
    [' 0712345678 ', '254712345678', 'pasted with stray spaces'],
    ['0712.345.678', '254712345678', 'dotted'],
    ['0712345678.', '254712345678', 'a trailing dot left by a form field'],
    ['tel:+254712345678', '254712345678', 'a pasted contact prefixed with tel:'],

    // The 01 prefixes Safaricom has issued since the 07 range ran short.
    ['0112345678', '254112345678', 'a new 01 prefix, local'],
    ['+254112345678', '254112345678', 'a new 01 prefix, international'],
    ['0112 345 678', '254112345678', 'a new 01 prefix, spaced'],

    // Refused, with a reason the operator can give the member.
    ['', null, 'empty'],
    [null, null, 'nothing at all'],
    ['not a number', null, 'words'],
    ['0712345', null, 'too short'],
    ['07123456789', null, 'too long'],
    ['071234567', null, 'a landline rather than a mobile'],
    ['+2540712345678', null, 'a zero after the country code'],
    ['2540712345678', null, 'the local form with the country code glued on'],
    ['25471234567812345', null, 'far too long'],
    ['+1 555 010 9999', null, 'a valid number, but not Kenyan'],
];

echo "\n=== every format reduces to one number ===\n\n";

foreach ($formats as [$input, $expected, $label]) {
    $actual = Phone::normalise($input);
    $ok = $actual === $expected;

    if ($ok) {
        $pass++;
        printf("  PASS  %-34s -> %s\n", $label, $actual ?? 'refused');
    } else {
        $fail++;
        printf("  FAIL  %-34s -> %s, expected %s\n",
            $label, var_export($actual, true), var_export($expected, true));
    }
}

echo "\n=== the stored form a member is looked up by ===\n\n";

foreach ([
    ['254712345678', '0712345678', 'international becomes local'],
    ['+254712345678', '0712345678', 'a plus sign does not survive into storage'],
    ['0712345678', '0712345678', 'local stays local'],
    ['0112345678', '0112345678', 'an 01 prefix is kept as typed'],
    ['rubbish', null, 'an unusable number is refused, not stored as itself'],
] as [$input, $expected, $label]) {
    $actual = Phone::toMemberPhone($input);
    $ok = $actual === $expected;

    if ($ok) {
        $pass++;
        printf("  PASS  %-34s -> %s\n", $label, $actual ?? 'refused');
    } else {
        $fail++;
        printf("  FAIL  %-34s -> %s, expected %s\n",
            $label, var_export($actual, true), var_export($expected, true));
    }
}

echo "\n=== two spellings of one number are the same number ===\n\n";

/*
 * Each row says whether the two should be treated as one number. The rows that
 * must not match matter as much as the ones that must: an unusable number
 * compared equal to anything would credit a payment to the wrong person.
 */
$pairs = [
    ['0712345678', '254712345678', true, 'local against international'],
    ['+254712345678', '0712345678', true, 'a plus sign against a stored local number'],
    ['0712 345 678', '0712345678', true, 'a spaced number off a receipt'],
    ['00254712345678', '+254712345678', true, 'the 00 prefix against a plus'],
    ['0112345678', '+254112345678', true, 'an 01 prefix, both ways'],
    ['0712345678', '0712345679', false, 'two different numbers'],
    ['0712345678', null, false, 'an unusable number'],
    [null, '0712345678', false, 'nothing at all'],
    [null, null, false, 'nothing either side'],
    ['not a number', '0712345678', false, 'words against a real number'],
];

foreach ($pairs as [$a, $b, $expected, $label]) {
    $ok = Phone::sameNumber($a, $b) === $expected;

    if ($ok) {
        $pass++;
        printf("  PASS  %-44s %s\n", $label, $expected ? 'same' : 'different');
    } else {
        $fail++;
        printf("  FAIL  %-44s should be %s\n", $label, $expected ? 'the same' : 'different');
    }
}

printf("\npassed %d, failed %d\n", $pass, $fail);
exit($fail > 0 ? 1 : 0);