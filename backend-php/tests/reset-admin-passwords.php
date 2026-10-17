<?php

declare(strict_types=1);

/**
 * Puts administrator accounts back on the shared starting password, and requires
 * a change at the next sign-in.
 *
 * Why this exists
 * ---------------
 * The first sign-in uses one password for every administrator account, which is
 * written into the published repository. That is a deliberate convenience, and it
 * is only defensible because it expires: the app refuses everything except the
 * change of password itself until the account has replaced it.
 *
 * Something has to arm that requirement on accounts that already exist, and
 * something has to be able to put it back. Re-running `node seed.js` is not the
 * answer: it also rewrites the demo members, their contributions and their loans,
 * and it is the reason the notes next to it say not to point it at a live
 * database. This touches four columns across the administrator table and nothing
 * else.
 *
 * It is also the way back in. If the shared password is lost, or an account is
 * claimed by somebody who should not have it, this restores access from the
 * machine the app runs on - which is a thing only the operator can do, and which
 * is exactly the property that makes a shared starting password tolerable.
 *
 * Nothing is written unless --apply is passed. The default is to print what would
 * change, because the cost of a surprise here is four accounts locked or reset.
 *
 * Usage
 * -----
 *   php tests/reset-admin-passwords.php                      what would change
 *   php tests/reset-admin-passwords.php --apply              reset and arm
 *   php tests/reset-admin-passwords.php --apply --only=admin one account only
 *   php tests/reset-admin-passwords.php --apply --unblock    let the checks run
 *   php tests/reset-admin-passwords.php --apply --password=...  a specific value
 *
 * The password comes from ADMIN_PASSWORD in backend-php/.env unless --password says
 * otherwise. The checks read the same variable, so the two stay in step.
 *
 * --unblock clears the requirement without touching any password. It exists for
 * the check suites, which sign in as the shared administrator account and cannot
 * exercise anything while that account is refused everywhere. Run it before
 * `node check.mjs`, and run this script again without it afterwards to put the
 * requirement back.
 *
 * Run from the source checkout, not from the installed copy under htdocs: it is
 * a maintenance tool, and it is deliberately not deployed to the web root, where
 * a request could reach it.
 */

require __DIR__ . '/../vendor/autoload.php';

use TheTeam\Database;
use TheTeam\Env;

/*
 * The checkout layout: this file is at backend-php/tests/, the Node backend with
 * its .env is at ../backend/. Both roots are offered because a deployment may keep
 * its configuration in either, and Env::load leaves the first value it finds in
 * place.
 */
Env::load(dirname(__DIR__, 2) . '/backend-php');
Env::load(dirname(__DIR__, 2));

$options = getopt('', ['apply', 'unblock', 'password::', 'only::']);

$apply = array_key_exists('apply', $options);
$unblock = array_key_exists('unblock', $options);
$password = is_string($options['password'] ?? null) ? $options['password'] : null;
$only = is_string($options['only'] ?? null) ? array_filter(array_map('trim', explode(',', $options['only']))) : [];

if ($password === null) {
    $password = Env::get('ADMIN_PASSWORD');
}

echo "\nTHE TEAM - administrator passwords\n";
echo str_repeat('-', 68) . "\n";

if (!$unblock) {
    if ($password === null || $password === '') {
        echo "\nNo password to set.\n\n";
        echo "Set ADMIN_PASSWORD in backend-php/.env, or pass --password=... :\n\n";
        echo "  php tests/reset-admin-passwords.php --apply --password=admin1234\n\n";
        exit(1);
    }

    if (strlen($password) < 8) {
        /*
         * The sign-in itself accepts anything, because the account already has a
         * hash and this is not where it is checked. Every route out of the state
         * requires eight characters, though, so a shorter value here would arm an
         * account that cannot reach the screen that would fix it. Refused early,
         * while it is still a message rather than a dead end.
         */
        echo "\nThat password is " . strlen($password) . " characters. The change screen requires at\n";
        echo "least 8, so an account set to this could not be changed from inside the app.\n\n";
        exit(1);
    }
}

$admins = Database::all(
    'SELECT id, username, full_name, must_change_password FROM admins ORDER BY id'
);

if ($admins === []) {
    echo "\nNo administrator accounts exist yet. Run: node seed.js\n\n";
    exit(1);
}

$targets = [];
foreach ($admins as $admin) {
    if ($only !== [] && !in_array((string) $admin['username'], $only, true)) {
        continue;
    }
    $targets[] = $admin;
}

if ($targets === []) {
    echo "\nNo account matched --only=" . implode(',', $only) . ".\n";
    echo "Accounts present: " . implode(', ', array_column($admins, 'username')) . "\n\n";
    exit(1);
}

echo "\nAccounts " . ($unblock ? '(clearing the change requirement)' : '(set to the shared starting password and flagged)') . ":\n\n";
foreach ($targets as $admin) {
    $state = !empty($admin['must_change_password']) ? 'waiting for a change' : 'in normal use';
    echo sprintf("  %-12s %-24s %s\n", $admin['username'], $admin['full_name'], $state);
}

if ($apply) {
    Database::transaction(function (PDO $pdo) use ($targets, $password, $unblock) {
        if ($unblock) {
            $statement = $pdo->prepare('UPDATE admins SET must_change_password = 0 WHERE id = ?');
            foreach ($targets as $admin) {
                $statement->execute([$admin['id']]);
            }
            return;
        }

        /*
         * Cost 12, matching every other place a password hash is written in this
         * project. A different cost is not an error, but a table with two costs in
         * it is a table where the strength of a password depends on which screen
         * last set it.
         */
        $hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
        $statement = $pdo->prepare(
            'UPDATE admins SET password_hash = ?, must_change_password = 1 WHERE id = ?'
        );
        foreach ($targets as $admin) {
            $statement->execute([$hash, $admin['id']]);
        }
    });

    echo "\nDone. " . count($targets) . " account(s) updated.\n";
    if ($unblock) {
        echo "They will sign in normally. Run this script without --unblock afterwards to\n";
        echo "require a change again.\n\n";
    } else {
        echo "\nEach of these now signs in with the shared starting password and can do\n";
        echo "nothing else until it has chosen its own.\n\n";
    }
} else {
    echo "\nNothing was written. Re-run with --apply to make these changes.\n\n";
}
