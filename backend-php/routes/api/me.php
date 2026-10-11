<?php

declare(strict_types=1);

/**
 * The signed-in user's own preferences.
 *
 * A direct translation of backend/routes/me.js. Both token types: a member and an
 * admin each have a language preference of their own, and the column lives in a
 * different table for each.
 */

use TheTeam\Auth;
use TheTeam\Controllers\PreferencesController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    $router->get($prefix . '/language', function (Request $r) {
        Auth::requireEither($r);
        PreferencesController::getMyLanguage($r);
    });

    $router->put($prefix . '/language', function (Request $r) {
        Auth::requireEither($r);
        PreferencesController::setMyLanguage($r);
    });
};