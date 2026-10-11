<?php

declare(strict_types=1);

/**
 * Group figures for the member portal.
 *
 * Deliberately available to members, not only to admins. A member-token only:
 * admins get these figures on the admin dashboard, and routing them through the
 * same place would mean one screen serving two very different audiences.
 */

use TheTeam\Auth;
use TheTeam\Controllers\TransparencyController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    $router->get($prefix, function (Request $r) {
        Auth::requireMember($r);
        TransparencyController::getTransparency($r);
    });
};