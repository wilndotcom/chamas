<?php

declare(strict_types=1);

/**
 * Members.
 *
 * A direct translation of backend/routes/members.js, including the order the
 * routes are registered in. That order matters: '/:id' would otherwise match
 * '/dashboard' and '/registrations', so the specific paths have to be declared
 * first.
 */

use TheTeam\Auth;
use TheTeam\Controllers\MemberController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    // Before '/:id', which would otherwise swallow both of these.
    $router->get($prefix . '/dashboard', function (Request $r) {
        Auth::requireMember($r);
        MemberController::getMemberDashboard($r);
    });

    $router->get($prefix . '/registrations', function (Request $r) {
        $user = Auth::require($r, 'admin');
        Auth::authorize($r, ['manage_members']);
        MemberController::getPendingMembers($r);
    });

    $router->post($prefix . '/registrations/:id/approve', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['manage_members']);
        MemberController::approveMember($r);
    });

    $router->post($prefix . '/registrations/:id/reject', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['manage_members']);
        MemberController::rejectMember($r);
    });

    $router->get($prefix, function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['view_members']);
        MemberController::getAllMembers($r);
    });

    $router->get($prefix . '/:id', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['view_members']);
        MemberController::getMember($r);
    });

    $router->post($prefix, function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['manage_members']);
        MemberController::createMember($r);
    });

    $router->put($prefix . '/:id', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['manage_members']);
        MemberController::updateMember($r);
    });

    $router->patch($prefix . '/:id/status', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['manage_members']);
        MemberController::setMemberStatus($r);
    });

    $router->delete($prefix . '/:id', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['manage_members']);
        MemberController::deleteMember($r);
    });
};