<?php

declare(strict_types=1);

/**
 * Loans.
 *
 * A direct translation of backend/routes/loans.js, in the same order. That order
 * matters: '/mine' is declared before '/:id/pay' only for readability, but the
 * literal paths must come before any pattern that could swallow them.
 */

use TheTeam\Auth;
use TheTeam\Controllers\LoanController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    // Member routes first: they authenticate with a member token, and a member
    // token must never reach an admin route.
    $router->get($prefix . '/mine', function (Request $r) {
        Auth::requireMember($r);
        LoanController::getMyLoans($r);
    });

    $router->post($prefix . '/apply', function (Request $r) {
        Auth::requireMember($r);
        LoanController::applyForLoan($r);
    });

    $router->post($prefix . '/:id/pay', function (Request $r) {
        Auth::requireMember($r);
        LoanController::repayMyLoan($r);
    });

    // Admin routes.
    $router->get($prefix . '/pending', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['approve_loans']);
        LoanController::getPendingLoans($r);
    });

    $router->post($prefix . '/repayment', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['record_contributions']);
        LoanController::recordRepayment($r);
    });

    $router->post($prefix . '/:id/approve', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['approve_loans']);
        LoanController::approveLoan($r);
    });

    $router->post($prefix . '/:id/disburse', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['approve_loans']);
        LoanController::disburseLoan($r);
    });

    $router->get($prefix, function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['view_loans']);
        LoanController::getAllLoans($r);
    });
};