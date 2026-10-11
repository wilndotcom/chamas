<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Database;
use TheTeam\Log;
use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Utils\MpesaConfig;

/**
 * Payment gateway registry.
 *
 * A port of backend/controllers/paymentGatewayController.js.
 *
 * A gateway is a way of paying (M-Pesa, bank, cash). Turning one off removes it
 * from every payment method list across both portals, which is the point: the
 * choice of accepted methods is configuration rather than something hardcoded in
 * four different dropdowns.
 *
 * Credentials are not stored here. M-Pesa keeps its keys in settings; this table
 * is the catalogue.
 */
final class PaymentGatewayController
{
    /**
     * Which stored payment_method values each gateway covers.
     *
     * One gateway to one method, so an operator can offer a paybill without also
     * offering STK Push. The enum is finer-grained than the gateway, which is why
     * the mapping is written out rather than inferred from names.
     *
     * M-Pesa's two products stay in one payment_method pair because Daraja's
     * credentials are shared; only the registered endpoint differs.
     */
    private const GATEWAY_METHODS = [
        'mpesa_stk' => ['mpesa_stk'],
        'mpesa_c2b' => ['mpesa_c2b'],
        'airtel_money' => ['airtel_money'],
        'bank' => ['bank'],
        'cash' => ['cash'],
    ];

    private const LABELS = [
        'mpesa_stk' => 'M-Pesa (STK Push)',
        'mpesa_c2b' => 'M-Pesa (paybill / C2B)',
        'airtel_money' => 'Airtel Money',
        'bank' => 'Bank Transfer',
        'cash' => 'Cash',
    ];

    /**
     * The Daraja endpoint each M-Pesa gateway needs registered.
     *
     * Surfaced because that is the one thing about M-Pesa that cannot be done from
     * the app, and getting it wrong produces an opaque rejection.
     */
    private const DARJAJA_ENDPOINTS = [
        'mpesa_stk' => 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
        'mpesa_c2b' => 'Callback URL (Safaricom posts the confirmation to your app)',
    ];

    /**
     * Whether a gateway could take money right now.
     *
     * Only M-Pesa is checked in depth, because it is the only one with
     * credentials stored today. Airtel Money is deliberately reported as not
     * configured until its own keys are filled in, rather than being assumed to
     * work.
     */
    private static function isGatewayUsable(string $key, bool $mpesaReady): bool
    {
        if ($key === 'mpesa_stk' || $key === 'mpesa_c2b') {
            return $mpesaReady;
        }

        if ($key === 'airtel_money') {
            return false;
        }

        // Bank and cash are recorded by hand.
        return true;
    }

    /** Lists every gateway with its enabled state and configuration status. */
    public static function listGateways(Request $r): void
    {
        try {
            $rows = Database::all(
                'SELECT * FROM payment_gateways ORDER BY sort_order, gateway_key'
            );

            $mpesa = MpesaConfig::get();
            $mpesaReady = MpesaConfig::isConfigured($mpesa);

            $gateways = array_map(static function (array $row) use ($mpesaReady): array {
                $key = (string) $row['gateway_key'];

                return [
                    'gateway_key' => $key,
                    'display_name' => $row['display_name'],
                    'description' => $row['description'],
                    'is_enabled' => (bool) $row['is_enabled'],
                    'requires_config' => (bool) $row['requires_config'],
                    'sort_order' => $row['sort_order'],
                    // Airtel Money is listed and selectable but not wired, and
                    // the UI says so rather than quietly taking money.
                    'is_wired' => $key !== 'airtel_money',
                    'daraja_endpoint' => self::DARJAJA_ENDPOINTS[$key] ?? null,
                    'methods' => array_map(
                        static fn($m) => ['value' => $m, 'label' => self::LABELS[$m] ?? $m],
                        self::GATEWAY_METHODS[$key] ?? []
                    ),
                    'is_configured' => self::isGatewayUsable($key, $mpesaReady),
                ];
            }, $rows);

            /*
             * Only wired methods are offered.
             *
             * Separate from is_configured because that answers "are the
             * credentials there", while this answers "would choosing this
             * actually work". A gateway can be enabled and configured yet still
             * be unwired, and offering it to a member would be worse than not
             * offering it: the payment would never be confirmed.
             */
            $enabled = [];
            foreach ($gateways as $gateway) {
                if ($gateway['is_enabled']) {
                    foreach ($gateway['methods'] as $method) {
                        $enabled[] = $method;
                    }
                }
            }

            $wired = array_values(array_filter(
                $enabled,
                static fn($m) => $m['value'] !== 'airtel_money'
            ));

            $suppressed = count($enabled) - count($wired);

            if ($suppressed > 0) {
                $enabled = $wired;
            }

            // Cash is always offered as a floor. A group with every gateway
            // switched off must still be able to record that somebody walked in
            // and paid cash.
            $fallbackApplied = $enabled === [];

            if ($fallbackApplied) {
                $enabled = array_map(
                    static fn($m) => ['value' => $m, 'label' => self::LABELS[$m] ?? $m],
                    self::GATEWAY_METHODS['cash']
                );
            }

            Response::json([
                'gateways' => $gateways,
                'enabled_methods' => $enabled,
                'suppressed_unwired' => $suppressed,
                'fallback_applied' => $fallbackApplied,
                'fallback_note' => $fallbackApplied
                    ? 'Every payment gateway is switched off, so Cash is still being offered. '
                        . 'Turn one back on to change this.'
                    : null,
                'mpesa_callback_placeholder' => !MpesaConfig::callbackReachable($mpesa),
            ]);
        } catch (\Throwable $e) {
            Log::warn('listGateways: ' . $e->getMessage());
            Response::error('Failed to load payment gateways.', 500);
        }
    }

    /** Turns a gateway on or off, and renames it if asked. */
    public static function updateGateway(Request $r): void
    {
        try {
            $key = (string) $r->param('key');
            $body = $r->body();

            $current = Database::one(
                'SELECT * FROM payment_gateways WHERE gateway_key = ?',
                [$key]
            );

            if ($current === null) {
                Response::error("No payment gateway called {$key}.", 404);
            }

            $nextEnabled = array_key_exists('is_enabled', $body)
                ? (bool) $body['is_enabled']
                : (bool) $current['is_enabled'];

            $nextName = (!isset($body['display_name'])
                || trim((string) $body['display_name']) === '')
                ? $current['display_name']
                : mb_substr(trim((string) $body['display_name']), 0, 100);

            /*
             * The last enabled gateway cannot be switched off.
             *
             * Every payment form draws its methods from the enabled list, so
             * switching off the last one leaves a member unable to record that
             * they paid. Cash is enforced at the list level as a floor, but
             * refusing here says so at the point the operator is deciding.
             */
            if ($current['is_enabled'] && !$nextEnabled) {
                $others = (int) Database::scalar(
                    'SELECT COUNT(*) FROM payment_gateways WHERE is_enabled = 1 AND gateway_key <> ?',
                    [$key]
                );

                if ($others === 0) {
                    Response::error(
                        'This is the last enabled payment gateway. Enable another one first, '
                        . 'otherwise there is no way to record a payment.',
                        400
                    );
                }
            }

            Database::run(
                'UPDATE payment_gateways SET is_enabled = ?, display_name = ? WHERE gateway_key = ?',
                [$nextEnabled ? 1 : 0, $nextName, $key]
            );

            Response::json([
                'success' => true,
                'gateway_key' => $key,
                'is_enabled' => $nextEnabled,
                'display_name' => $nextName,
                'message' => sprintf(
                    '%s is now %s.',
                    $nextName,
                    $nextEnabled ? 'accepted' : 'hidden from payment methods'
                ),
            ]);
        } catch (\Throwable $e) {
            Log::warn('updateGateway: ' . $e->getMessage());
            Response::error('Failed to update the payment gateway.', 500);
        }
    }
}