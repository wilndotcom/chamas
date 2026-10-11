<?php

declare(strict_types=1);

/**
 * Roles.
 *
 * A direct translation of backend/routes/roles.js. Super admin only: a role that
 * grants permissions must not be editable by an admin who does not hold them.
 */

use TheTeam\Auth;
use TheTeam\Controllers\RolesController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    $router->get($prefix, function (Request $r) {
        Auth::requireSuperAdmin($r);
        RolesController::getRoles($r);
    });

    $router->post($prefix, function (Request $r) {
        Auth::requireSuperAdmin($r);
        RolesController::createRole($r);
    });

    // Before '/:id', which would otherwise match '/:id/permissions'.
    $router->put($prefix . '/:id/permissions', function (Request $r) {
        Auth::requireSuperAdmin($r);
        RolesController::setRolePermissions($r);
    });

    $router->put($prefix . '/:id', function (Request $r) {
        Auth::requireSuperAdmin($r);
        RolesController::updateRole($r);
    });

    $router->delete($prefix . '/:id', function (Request $r) {
        Auth::requireSuperAdmin($r);
        RolesController::deleteRole($r);
    });
};