<?php

declare(strict_types=1);

/**
 * The cash book.
 *
 * A direct translation of backend/routes/ledger.js.
 */

use TheTeam\Auth;
use TheTeam\Controllers\LedgerController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    $router->get($prefix . '/cashbook', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['view_reports']);
        LedgerController::getCashBook($r);
    });

    $router->post($prefix, function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['record_contributions']);
        LedgerController::recordLedgerEntry($r);
    });

    $router->delete($prefix . '/:id', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['record_contributions']);
        LedgerController::deleteLedgerEntry($r);
    });
};