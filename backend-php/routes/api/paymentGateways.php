<?php

declare(strict_types=1);

/**
 * Payment gateways.
 *
 * A direct translation of backend/routes/paymentGateways.js.
 *
 * The list is readable by both portals: the member payment forms have to offer
 * exactly the methods the admin has switched on, and requiring one token type
 * would only push the frontend toward a hardcoded list.
 */

use TheTeam\Auth;
use TheTeam\Controllers\PaymentGatewayController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    $router->get($prefix, function (Request $r) {
        Auth::requireEither($r);
        PaymentGatewayController::listGateways($r);
    });

    $router->put($prefix . '/:key', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['system_settings']);
        PaymentGatewayController::updateGateway($r);
    });
};