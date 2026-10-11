<?php

declare(strict_types=1);

/**
 * M-Pesa.
 *
 * A direct translation of backend/routes/mpesa.js.
 */

use TheTeam\Auth;
use TheTeam\Controllers\MpesaController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    /*
     * The callbacks are deliberately unauthenticated.
     *
     * Safaricom posts to these with no credentials of ours, so they cannot sit
     * behind the usual token check. They are identified instead by the
     * transaction ID they quote, which only Safaricom and this server have seen.
     * Locking them behind auth would mean Safaricom's confirmation is rejected
     * and every payment stays "pending" forever.
     */
    $router->post($prefix . '/confirmation', function (Request $r) {
        MpesaController::c2bConfirmation($r);
    });

    $router->post($prefix . '/validation', function (Request $r) {
        MpesaController::c2bValidation($r);
    });

    $router->post($prefix . '/callback', function (Request $r) {
        MpesaController::mpesaCallback($r);
    });

    /*
     * An STK prompt sends a real payment request to a real phone. authenticate
     * already limits this to admins; the permission check stops a
     * lower-privileged admin such as a secretary from sending prompts to
     * arbitrary numbers and recording nothing.
     */
    $router->post($prefix . '/stk-push', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['record_contributions']);
        MpesaController::stkPush($r);
    });

    /*
     * Test prompt: same Daraja call, nothing recorded.
     *
     * Restricted to system_settings because it exists to verify the Daraja
     * setup, not to collect money, and it accepts any phone number.
     */
    $router->post($prefix . '/test-prompt', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['system_settings']);
        MpesaController::stkTestPrompt($r);
    });

    $router->post($prefix . '/register-c2b', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['system_settings']);
        MpesaController::registerC2BUrls($r);
    });

    $router->get($prefix . '/status', function (Request $r) {
        Auth::require($r, 'admin');
        MpesaController::mpesaStatus($r);
    });
};