<?php

declare(strict_types=1);

/**
 * Chama branding.
 *
 * A direct translation of backend/routes/chama.js. The profile and the logo are
 * public: the sign-in screen shows the logo to people who have not signed in yet,
 * so requiring a token would leave the branded login looking unbranded.
 */

use TheTeam\Auth;
use TheTeam\Controllers\ChamaController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    $router->get($prefix . '/logo', function (Request $r) {
        ChamaController::getLogo($r);
    });

    $router->get($prefix . '/profile', function (Request $r) {
        ChamaController::getProfile($r);
    });

    $router->put($prefix . '/logo', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['system_settings']);
        ChamaController::uploadLogo($r);
    });

    $router->delete($prefix . '/logo', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['system_settings']);
        ChamaController::deleteLogo($r);
    });
};