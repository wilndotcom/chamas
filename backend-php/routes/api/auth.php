<?php

declare(strict_types=1);

namespace TheTeam;

/**
 * Login, registration, profile and impersonation.
 *
 * A direct port of backend/controllers/authController.js. The route order and
 * permission requirements match the Node routes/auth.js, including which
 * endpoints are deliberately unauthenticated.
 */
use TheTeam\Auth;
use TheTeam\Controllers\AuthController;
use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    $router->post($prefix . '/admin-login', function (Request $r) {
        AuthController::adminLogin($r);
    });

    $router->post($prefix . '/member-login', function (Request $r) {
        AuthController::memberLogin($r);
    });

    $router->post($prefix . '/register', function (Request $r) {
        AuthController::memberRegister($r);
    });

    $router->get($prefix . '/profile', function (Request $r) {
        $user = Auth::require($r, 'admin');
        AuthController::adminProfile($r, $user);
    });

    $router->get($prefix . '/member-profile', function (Request $r) {
        $user = Auth::requireMember($r);
        AuthController::memberProfile($r, $user);
    });

    $router->put($prefix . '/change-password', function (Request $r) {
        $user = Auth::requireEither($r);
        AuthController::changePassword($r, $user);
    });

    /*
     * Unauthenticated, matching the Node route. This endpoint's whole job is to
     * replace a token that is about to expire, so requiring a valid one first
     * would be circular. The controller reads the header and verifies it itself,
     * which is also how it can tell an expired session from a missing one.
     */
    $router->post($prefix . '/refresh', function (Request $r) {
        AuthController::refreshToken($r);
    });

    $router->get($prefix . '/impersonation-targets', function (Request $r) {
        $user = Auth::requireSuperAdmin($r);
        AuthController::impersonationTargets($r, $user);
    });

    $router->post($prefix . '/impersonate', function (Request $r) {
        $user = Auth::requireSuperAdmin($r);
        AuthController::impersonate($r, $user);
    });
};