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
     * The STK callback is deliberately unauthenticated.
     *
     * Safaricom posts to it with no credentials of ours, so it cannot sit behind
     * the usual token check. It is identified instead by the checkout ID it
     * quotes, which only Safaricom and this server have seen. Locking it behind
     * auth would mean the confirmation is rejected and every payment stays
     * "pending" forever.
     */
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

    $router->get($prefix . '/status', function (Request $r) {
        Auth::require($r, 'admin');
        MpesaController::mpesaStatus($r);
    });
};