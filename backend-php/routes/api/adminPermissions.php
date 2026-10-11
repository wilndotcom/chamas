<?php

declare(strict_types=1);

/**
 * Per-admin permission overrides, mounted at /api/admin-permissions.
 *
 * Kept separate from /api/roles so the id in the path is unambiguously an ADMIN
 * id, not a role id. The two are similar-looking numbers and a wrong guess there
 * changes somebody's rights without anybody meaning to.
 */

use TheTeam\Auth;
use TheTeam\Controllers\RolesController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    $router->get($prefix . '/:adminId', function (Request $r) {
        Auth::requireSuperAdmin($r);
        RolesController::getAdminOverrides($r);
    });

    $router->put($prefix . '/:adminId', function (Request $r) {
        Auth::requireSuperAdmin($r);
        RolesController::setAdminOverrides($r);
    });
};