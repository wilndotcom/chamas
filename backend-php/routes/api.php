<?php

declare(strict_types=1);

namespace TheTeam;

/**
 * API route table.
 *
 * Reads as a direct translation of the Node route files, so the two can be
 * compared endpoint by endpoint when checking the port.
 *
 * Each group returns a closure taking the router and the prefix, which is what
 * Router::group() calls. That mirrors app.use('/api/loans', loansRoutes) with the
 * routes declared in their own file.
 */
use TheTeam\ApiRoutes;
use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Router;

/**
 * Groups to mount, in the order the Node server mounts them.
 *
 * A group whose file is not written yet is recorded as pending rather than
 * silently skipped. That distinction matters while the port is in progress: a
 * route that 404s because it was forgotten and one that 404s because it is
 * unported look identical from outside, and only the first is a bug.
 */
$groups = [
    ['/api/auth',               'auth.php'],
    ['/api/account',            'account.php'],
    ['/api/admins',             'admins.php'],
    ['/api/members',            'members.php'],
    ['/api/contributions',      'contributions.php'],
    ['/api/loans',              'loans.php'],
    ['/api/welfare',            'welfare.php'],
    ['/api/transparency',       'transparency.php'],
    ['/api/notifications',      'notifications.php'],
    ['/api/settings',           'settings.php'],
    ['/api/mpesa',              'mpesa.php'],
    ['/api/reports',            'reports.php'],
    ['/api/ledger',             'ledger.php'],
    ['/api/roles',              'roles.php'],
    ['/api/admin-permissions',  'adminPermissions.php'],
    ['/api/chama',              'chama.php'],
    ['/api/payment-gateways',   'paymentGateways.php'],
    ['/api/me',                 'me.php'],
];

return function (Router $router) use ($groups): void {
    foreach ($groups as [$prefix, $file]) {
        $path = __DIR__ . '/api/' . $file;

        if (!is_file($path)) {
            ApiRoutes::pending($router, $prefix);
            continue;
        }

        ApiRoutes::mount($router, $prefix, $path);
    }
};