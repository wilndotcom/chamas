<?php

declare(strict_types=1);

/**
 * Notifications.
 *
 * A direct translation of backend/routes/notifications.js.
 *
 * Channel configuration needs system_settings rather than send_notifications:
 * reading it sends nothing, but it reports whether a usable API key is present,
 * which is a credential-adjacent fact. An admin who can message members does not
 * automatically need to see which keys are configured.
 *
 * Testing a channel needs both: permission to send, and permission over the
 * configuration that authorises it.
 */

use TheTeam\Auth;
use TheTeam\Controllers\NotificationController;
use TheTeam\Request;
use TheTeam\Router;

return function (Router $router, string $prefix): void {
    // Before '/:id'-style paths and before '/my-notifications', which would
    // otherwise be caught by a wildcard.
    $router->get($prefix . '/my-notifications', function (Request $r) {
        Auth::requireMember($r);
        NotificationController::getMemberNotifications($r);
    });

    $router->get($prefix . '/templates', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['send_notifications']);
        NotificationController::getTemplateInfo($r);
    });

    $router->post($prefix . '/templates/test', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['send_notifications']);
        NotificationController::testTemplate($r);
    });

    $router->get($prefix . '/channels', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['system_settings']);
        NotificationController::getChannelStatus($r);
    });

    $router->post($prefix . '/channels/test', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['system_settings', 'send_notifications']);
        NotificationController::testChannel($r);
    });

    $router->get($prefix, function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['send_notifications']);
        NotificationController::getAllNotifications($r);
    });

    $router->post($prefix . '/send', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['send_notifications']);
        NotificationController::sendNotification($r);
    });

    $router->post($prefix . '/send-bulk', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['send_notifications']);
        NotificationController::sendBulkNotification($r);
    });

    $router->post($prefix . '/remind', function (Request $r) {
        Auth::require($r, 'admin');
        Auth::authorize($r, ['send_notifications']);
        NotificationController::sendReminders($r);
    });
};