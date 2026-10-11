<?php

declare(strict_types=1);

/**
 * Password reset and two-factor login.
 *
 * A direct translation of backend/routes/account.js. The reset endpoints are
 * unauthenticated by necessity - a locked-out administrator is precisely who
 * needs them - and rate limited on their own counter rather than sharing login's.
 */

use TheTeam\Auth;
use TheTeam\Controllers\AccountController;
use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    $router->post($prefix . '/request-reset', function (Request $r) {
        AccountController::requestPasswordReset($r);
    });

    $router->post($prefix . '/complete-reset', function (Request $r) {
        AccountController::completePasswordReset($r);
    });

    /*
     * A two-factor code for an admin part-way through signing in.
     *
     * Takes the admin id in the body rather than from a token, because at this
     * point the password has been accepted but the session is not yet trusted.
     *
     * The handler still reads the enabled flag from the database, so a caller
     * cannot pass somebody's id and skip their second factor.
     */
    $router->post($prefix . '/request-code', function (Request $r) {
        $adminId = (int) ($r->body()['admin_id'] ?? 0);

        if ($adminId <= 0) {
            Response::error('An administrator is required.', 400);
        }

        // Presents as a signed-in principal carrying only an id, which is all the
        // handler reads. The enabled flag is read fresh from the database below,
        // so this cannot be used to skip somebody's second factor.
        $r->user = ['id' => $adminId, 'type' => 'admin'];

        AccountController::issueTwoFactorCode($r);
    });

    $router->post($prefix . '/verify-code', function (Request $r) {
        Auth::require($r, 'admin');
        AccountController::verifyTwoFactorCode($r);
    });

    $router->post($prefix . '/two-factor', function (Request $r) {
        Auth::require($r, 'admin');
        AccountController::setTwoFactor($r);
    });
};