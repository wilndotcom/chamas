<?php

declare(strict_types=1);

/**
 * Settings.
 *
 * A direct translation of backend/routes/settings.js.
 *
 * `/public` is deliberately unauthenticated: the client needs the currency and
 * theme to format every amount on screen, before anybody has signed in. It
 * returns an explicit key list rather than filtering the full table, so a
 * credential added later cannot leak by being forgotten.
 */

use TheTeam\Auth;
use TheTeam\Controllers\SettingsController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    // Before '/:key', which would otherwise match 'public' and 'about'.
    $router->get($prefix . '/public', function (Request $r) {
        SettingsController::getPublicSettings($r);
    });

    $router->get($prefix . '/about', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['system_settings']);
        SettingsController::getAbout($r);
    });

    $router->get($prefix, function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['system_settings']);
        SettingsController::getAllSettings($r);
    });

    $router->put($prefix, function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['system_settings']);
        SettingsController::updateSettings($r);
    });

    $router->put($prefix . '/:key', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['system_settings']);
        SettingsController::updateSetting($r);
    });
};