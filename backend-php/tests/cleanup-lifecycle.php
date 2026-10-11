<?php

declare(strict_types=1);

/**
 * Removes the rows left behind by check-lifecycle.mjs.
 *
 * The lifecycle check has to create real records - there is no value in testing
 * a welfare fund against a fixture when the whole point is that it works on real
 * money. Those records cannot be removed through the API, and that is correct:
 * a member with financial history is protected from deletion by design, and
 * removing them any other way would defeat the protection worth having.
 *
 * So this goes around the API on purpose, and it is deliberately narrow: it
 * removes only members named "Lifecycle Test" and anything that hangs off them.
 * Anything else is left alone, and the count of each is printed so a run is never
 * a silent change to the database.
 *
 * Run:  php tests/cleanup-lifecycle.php
 */

require __DIR__ . '/../vendor/autoload.php';

use TheTeam\Database;
use TheTeam\Env;

Env::load(dirname(__DIR__) . '/backend');

echo "\nFinding lifecycle test records...\n";

$members = Database::all(
    "SELECT id, full_name, phone FROM members WHERE full_name = 'Lifecycle Test'"
);

if ($members === []) {
    echo "  none found - nothing to clean up\n\n";
    exit(0);
}

$ids = array_column($members, 'id');

echo '  found ' . count($members) . " test member(s)\n";
foreach ($members as $member) {
    echo "    id {$member['id']}  {$member['full_name']}  {$member['phone']}\n";
}

/*
 * Every table that references members, and the column doing the referencing.
 *
 * Several tables have more than one column pointing at members - ledger_entries
 * has both member_id and recorded_by - so each is listed under every column that
 * would block the delete. Deleting on one column and leaving the other would
 * fail on the foreign key, which is exactly what happened the first time: the
 * ledger rows went on recorded_by, and member_id kept them alive.
 */
$targets = [
    ['ledger_entries', ['member_id', 'recorded_by']],
    ['loan_repayments', ['member_id']],
    ['loans', ['member_id']],
    ['welfare_requests', ['member_id']],
    ['welfare_contributions', ['member_id']],
    ['contributions', ['member_id']],
];

foreach ($targets as [$table, $columns]) {
    foreach ($columns as $column) {
        $placeholders = implode(',', array_fill(0, count($ids), '?'));

        $count = Database::scalar(
            "SELECT COUNT(*) FROM {$table} WHERE {$column} IN ({$placeholders})",
            $ids
        );

        if ((int) $count === 0) {
            continue;
        }

        Database::run(
            "DELETE FROM {$table} WHERE {$column} IN ({$placeholders})",
            $ids
        );

        echo "  removed {$count} row(s) from {$table}.{$column}\n";
    }
}

// The members themselves.
Database::run(
    'DELETE FROM members WHERE id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')',
    $ids
);
echo '  removed ' . count($members) . " member row(s)\n";

echo "\nDone. Nothing outside these test records was touched.\n\n";