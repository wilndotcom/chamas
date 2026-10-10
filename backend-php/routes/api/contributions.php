<?php

declare(strict_types=1);

/**
 * Contributions.
 *
 * A direct translation of backend/routes/contributions.js.
 */

use TheTeam\Auth;
use TheTeam\Controllers\ContributionController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    // Before '/member/:member_id'; order does not otherwise matter here because
    // no pattern is a prefix of another at the same depth.
    $router->get($prefix . '/summary', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['view_reports']);
        ContributionController::getContributionSummary($r);
    });

    $router->get($prefix . '/member/:member_id', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['view_members']);
        ContributionController::getMemberContributions($r);
    });

    $router->get($prefix, function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['view_members']);
        ContributionController::getAllContributions($r);
    });

    $router->post($prefix, function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['record_contributions']);
        ContributionController::recordContribution($r);
    });
};