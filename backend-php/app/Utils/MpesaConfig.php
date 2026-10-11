<?php

declare(strict_types=1);

namespace TheTeam\Utils;

use TheTeam\Database;
use TheTeam\Env;
use TheTeam\Log;

/**
 * M-Pesa (Daraja) configuration.
 *
 * A port of backend/utils/mpesaConfig.js.
 *
 * Settings win over the environment, so an operator can fix a key without
 * editing a file on the server. Both sources get the same placeholder check,
 * because otherwise a sample .env full of "your_consumer_key" counts as
 * configured and gets sent to Safaricom, which fails with an opaque rejection.
 *
 * The result is cached briefly. Without a cache every STK push adds a database
 * round trip; with no expiry an admin's new key would not take effect until the
 * process restarted, and a successful save would look inert.
 */
final class MpesaConfig
{
    private const TTL_SECONDS = 30;

    private static ?array $cache = null;
    private static int $cachedAt = 0;

    /**
     * Values that look like a credential but are not one.
     *
     * The sample value shipped in .env.example passes an "is it empty" check and
     * would be sent to Safaricom as though it were real.
     */
    private const PLACEHOLDER = '/^(your[_-]|xxx|change_?me|todo|placeholder)/i';

    /** Whether a value is present and not a sample. */
    public static function usable($value): bool
    {
        if ($value === null) {
            return false;
        }

        $text = trim((string) $value);

        if ($text === '') {
            return false;
        }

        return preg_match(self::PLACEHOLDER, $text) !== 1;
    }

    /**
     * The effective configuration, and where each value came from.
     *
     * The source of each value is returned as well as the value, so Settings can
     * show an operator whether the field they typed is actually in use. "It is in
     * the database" and "it is being used" are different claims.
     */
    public static function get(bool $fresh = false): array
    {
        if (!$fresh && self::$cache !== null
            && (time() - self::$cachedAt) < self::TTL_SECONDS) {
            return self::$cache;
        }

        $fromDb = [];
        foreach ([
            'mpesa_consumer_key', 'mpesa_consumer_secret', 'mpesa_shortcode',
            'mpesa_passkey', 'mpesa_paybill', 'mpesa_callback_url', 'mpesa_environment',
        ] as $key) {
            $fromDb[$key] = Settings::get($key);
        }

        $pick = static function (string $key, string $envName) use ($fromDb): array {
            $saved = trim((string) ($fromDb[$key] ?? ''));

            if (self::usable($saved)) {
                return ['value' => $saved, 'from' => 'settings'];
            }

            $fromEnv = trim((string) (Env::get($envName) ?? ''));

            if (self::usable($fromEnv)) {
                return ['value' => $fromEnv, 'from' => 'env'];
            }

            return ['value' => '', 'from' => 'unset'];
        };

        $key = $pick('mpesa_consumer_key', 'MPESA_CONSUMER_KEY');
        $secret = $pick('mpesa_consumer_secret', 'MPESA_CONSUMER_SECRET');
        $shortcode = $pick('mpesa_shortcode', 'MPESA_SHORTCODE');
        $passkey = $pick('mpesa_passkey', 'MPESA_PASSKEY');

        // The paybill falls back to MPESA_SHORTCODE, matching the Node version.
        // Settings for both usually hold the same number anyway, and the two
        // columns existing separately is a historical artefact rather than a
        // feature.
        $paybill = $pick('mpesa_paybill', 'MPESA_SHORTCODE');

        // The callback is settable in Settings so nobody has to edit a file on the
        // server and restart. The placeholder is NOT filtered here on purpose: the
        // caller needs to see it in order to warn that confirmations will not
        // arrive. Whether that matters is the caller's decision, not this one's.
        $callback = trim((string) ($fromDb['mpesa_callback_url'] ?? ''));

        /*
         * Which Daraja deployment to talk to.
         *
         * Strictly "production" or not, rather than trusting whatever is stored.
         * Anything else is treated as sandbox: guessing wrong in that direction
         * costs a failed test rather than real money moving, and a stray value
         * must not resolve to the live endpoint by accident.
         */
        $envSaved = strtolower(trim((string) ($fromDb['mpesa_environment'] ?? '')));
        $envIsLive = $envSaved === 'production'
            || ($envSaved === '' && Env::get('MPESA_ENV') === 'production');

        self::$cache = [
            'env' => $envIsLive ? 'production' : 'sandbox',
            'consumerKey' => $key['value'],
            'consumerSecret' => $secret['value'],
            'shortcode' => $shortcode['value'],
            'passkey' => $passkey['value'],
            'paybill' => $paybill['value'],
            'callbackUrl' => self::usable($callback)
                ? $callback
                : trim((string) (Env::get('MPESA_CALLBACK_URL') ?? '')),
            'source' => [
                'consumerKey' => $key['from'],
                'consumerSecret' => $secret['from'],
                'shortcode' => $shortcode['from'],
                'passkey' => $passkey['from'],
                'paybill' => $paybill['from'],
                'callbackUrl' => self::usable($callback) ? 'settings' : 'env',
                'environment' => $envSaved !== ''
                    ? 'settings'
                    : (Env::get('MPESA_ENV') !== null ? 'env' : 'default'),
            ],
            // The endpoint the environment resolves to, so Settings can show it and
            // the operator can confirm at a glance which Daraja they are aimed at.
            'base_url' => $envIsLive
                ? 'https://api.safaricom.co.ke'
                : 'https://sandbox.safaricom.co.ke',
        ];

        self::$cachedAt = time();

        return self::$cache;
    }

    /** True when enough is present to attempt a Daraja call. */
    public static function isConfigured(array $config): bool
    {
        return (bool) (
            $config['consumerKey']
            && $config['consumerSecret']
            && $config['shortcode']
            && $config['passkey']
        );
    }

    /**
     * The base URL for the configured environment.
     *
     * Reads the value resolved in get() rather than re-deriving it, so the URL
     * Settings displays and the URL actually called cannot drift apart.
     */
    public static function baseUrl(array $config): string
    {
        return $config['base_url'] ?? (
            $config['env'] === 'production'
                ? 'https://api.safaricom.co.ke'
                : 'https://sandbox.safaricom.co.ke'
        );
    }

    /**
     * Whether a callback URL could actually receive a Safaricom POST.
     *
     * Registering a placeholder is worse than not registering at all: Safaricom
     * accepts the registration, so the operator believes the paybill is live, and
     * the money then arrives at a URL that answers 404 and the payment is never
     * recorded.
     */
    public static function callbackReachable(array $config): bool
    {
        $url = (string) ($config['callbackUrl'] ?? '');

        return $url !== ''
            && preg_match('/your[-_]?domain|example\.com|localhost/i', $url) !== 1;
    }


    /** Drops the cache so a newly saved value is picked up at once. */
    public static function invalidate(): void
    {
        self::$cache = null;
        self::$cachedAt = 0;
    }
}