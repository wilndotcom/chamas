<?php

declare(strict_types=1);

/**
 * The welfare fund.
 *
 * A direct translation of backend/routes/welfare.js.
 */

use TheTeam\Auth;
use TheTeam\Controllers\WelfareController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    /*
     * The member's own view of welfare.
     *
     * Before this existed a member could submit a request and then had no way to
     * see its outcome. That is the fastest way to lose people's trust in a fund,
     * so the member side is a first-class surface rather than an admin screen
     * with the member table filtered.
     */
    $router->get($prefix . '/my', function (Request $r) {
        Auth::requireMember($r);
        WelfareController::getMyWelfare($r);
    });

    /*
     * Contributing to welfare.
     *
     * Both roles reach this endpoint. The controller reads the token's type to
     * tell them apart: an admin names the member, and a member is always
     * recorded against their own id regardless of what the request body says.
     * Two handlers with the same name were avoided so the permission rule stays
     * in one place.
     */
    $router->post($prefix . '/contributions', function (Request $r) {
        Auth::requireEither($r);
        WelfareController::recordWelfareContribution($r);
    });

    $router->post($prefix . '/requests', function (Request $r) {
        Auth::requireMember($r);
        WelfareController::submitWelfareRequest($r);
    });

    // Admin routes.
    $router->get($prefix . '/contributions', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['view_members']);
        WelfareController::getAllWelfareContributions($r);
    });

    $router->get($prefix . '/requests', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['manage_welfare']);
        WelfareController::getWelfareRequests($r);
    });

    $router->get($prefix . '/fund', function (Request $r) {
        Auth::require($r, 'admin');
        WelfareController::getWelfareFund($r);
    });

    /*
     * Approve and pay out are separate steps.
     *
     * Approval is the committee's decision; disbursement is the money moving.
     * Combining them made an approved request look paid while the cash was still
     * in the fund, which is exactly the sort of thing that erodes trust.
     */
    $router->post($prefix . '/requests/:id/approve', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['manage_welfare']);
        WelfareController::approveWelfareRequest($r);
    });

    $router->post($prefix . '/requests/:id/disburse', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['manage_welfare']);
        WelfareController::disburseWelfareRequest($r);
    });

    $router->post($prefix . '/requests/:id/reject', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['manage_welfare']);
        WelfareController::rejectWelfareRequest($r);
    });
};