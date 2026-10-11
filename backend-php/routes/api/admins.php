<?php

declare(strict_types=1);

/**
 * Administrator accounts.
 *
 * A direct translation of backend/routes/admins.js. The literal paths come
 * before '/:id', which would otherwise match '/roles' and '/audit-logs'.
 */

use TheTeam\Auth;
use TheTeam\Controllers\AdminController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    $router->get($prefix . '/roles', function (Request $r) {
        Auth::require($r, 'admin');
        AdminController::getRoles($r);
    });

    $router->get($prefix . '/audit-logs', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['view_audit_logs']);
        AdminController::getAuditLogs($r);
    });

    $router->get($prefix, function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['manage_admins']);
        AdminController::getAllAdmins($r);
    });

    $router->post($prefix, function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['manage_admins']);
        AdminController::createAdmin($r);
    });

    $router->put($prefix . '/:id', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['manage_admins']);
        AdminController::updateAdmin($r);
    });

    $router->delete($prefix . '/:id', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['manage_admins']);
        AdminController::deleteAdmin($r);
    });
};