<?php

declare(strict_types=1);

/**
 * Reports.
 *
 * A direct translation of backend/routes/reports.js. The literal paths come
 * before '/member/:member_id', which is otherwise unaffected but is worth keeping
 * in the same order as the Node file for comparison.
 */

use TheTeam\Auth;
use TheTeam\Controllers\ReportController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    $router->get($prefix . '/financial-summary', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['view_reports']);
        ReportController::getFinancialSummary($r);
    });

    $router->get($prefix . '/monthly', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['view_reports']);
        ReportController::getMonthlyReport($r);
    });

    $router->get($prefix . '/member/:member_id', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['view_reports']);
        ReportController::getMemberStatement($r);
    });

    $router->get($prefix . '/growth', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['view_reports']);
        ReportController::getGrowthMetrics($r);
    });

    $router->get($prefix . '/reminders', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['view_reports', 'send_notifications']);
        ReportController::getReminders($r);
    });

    $router->get($prefix . '/expenses', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['view_reports']);
        ReportController::getExpenses($r);
    });

    $router->post($prefix . '/expenses', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['record_contributions']);
        ReportController::recordExpense($r);
    });

    $router->delete($prefix . '/expenses/:id', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['record_contributions']);
        ReportController::deleteExpense($r);
    });
};