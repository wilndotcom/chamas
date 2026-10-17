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

        /*
         * The callback, in order of preference.
         *
         * A saved value wins, because pointing confirmations somewhere other
         * than where this app is reached - a fixed domain, say, while it is also
         * served over a tunnel whose address changes - is a real reason to set
         * one by hand.
         *
         * Everything that is not a saved value loses to the address the request
         * arrived on. That includes the stand-ins: a placeholder in .env was
         * copied in with the example configuration and never filled in, and a
         * previously saved localhost is left over from testing on this machine.
         * Preferring either means the app tells Safaricom to post somewhere that
         * cannot exist while a working address sits one line away.
         */
        $savedCallback = trim((string) ($fromDb['mpesa_callback_url'] ?? ''));
        $savedCallback = self::usable($savedCallback) && !self::isPlaceholder($savedCallback)
            ? $savedCallback
            : '';

        $fromEnv = trim((string) (Env::get('MPESA_CALLBACK_URL') ?? ''));
        $fromEnv = self::usable($fromEnv) && !self::isPlaceholder($fromEnv) ? $fromEnv : '';

        $derived = self::deriveCallback();

        if ($savedCallback !== '') {
            $callback = $savedCallback;
            $callbackSource = 'settings';
        } elseif ($fromEnv !== '') {
            $callback = $fromEnv;
            $callbackSource = 'env';
        } elseif ($derived !== null) {
            $callback = $derived . '/api/mpesa/callback';
            $callbackSource = 'this server';
        } else {
            // Nothing to go on: show whatever placeholder exists so the operator
            // can see what is wrong with it, rather than an empty row.
            $callback = $savedCallback !== '' ? $savedCallback : $fromEnv;
            $callbackSource = 'unset';
        }

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
            'callbackUrl' => $callback,
            'source' => [
                'consumerKey' => $key['from'],
                'consumerSecret' => $secret['from'],
                'shortcode' => $shortcode['from'],
                'passkey' => $passkey['from'],
                'paybill' => $paybill['from'],
                'callbackUrl' => $callbackSource,
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
     * The public address of this server, worked out from the current request.
     *
     * Deliberately derived rather than configured: a callback typed by hand is
     * either right or silently wrong, and when it is wrong Safaricom accepts the
     * money and tells nobody. Deriving it means the operator types a till number
     * and nothing else.
     *
     * Returns null rather than guessing when there is no usable Host header.
     */
    private static function deriveCallback(): ?string
    {
        $host = trim((string) ($_SERVER['HTTP_HOST'] ?? ''));

        if ($host === '' || str_contains($host, '/') || str_contains($host, ' ')) {
            return null;
        }

        // The proxy or tunnel in front of the app terminates TLS, so Apache sees
        // plain HTTP. Reporting http here would hand Safaricom a callback it
        // refuses. Only this header may say https.
        $forwarded = strtolower(trim(explode(',', (string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
        $scheme = $forwarded === 'https' ? 'https' : 'http';

        $basePath = rtrim(trim((string) (Env::get('APP_BASE_PATH', '') ?? '')), '/');

        return $scheme . '://' . $host . $basePath;
    }

    /**
     * Remembers a public address so the app keeps working from anywhere.
     *
     * The problem this solves is a loop. The callback is worked out from
     * whichever address the operator is looking at, so browsing at localhost
     * always produces a localhost callback, which is never deliverable, which
     * blocks the prompt, and the only way out would be to change where they
     * browse. Saving the address removes the trap: a prompt sent from localhost
     * is confirmed back through the public address and lands on the same app.
     *
     * Tunnels and their addresses change, so learning it rather than being told
     * it is what makes this hold up: open the app once through a new address and
     * it re-pins itself, no visit to a settings screen.
     *
     * Deliberately narrow about when it will write:
     *
     *   - Only over a forwarded https connection. An admin looking at localhost
     *     must never be taken as the public address; that is the trap.
     *   - Only when the current callback is unusable, or was one this method
     *     learned. A callback somebody set deliberately is never overwritten,
     *     because there is no way to tell a considered choice from a stale one.
     *
     * Only ever called from routes that already require an admin token.
     * Failures are swallowed: this is a convenience, and losing it must never
     * stop a payment being sent.
     */
    public static function rememberPublicAddress(): void
    {
        $forwarded = strtolower(trim(explode(
            ',',
            (string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')
        )[0]));

        if ($forwarded !== 'https') {
            return;
        }

        $base = self::deriveCallback();

        if ($base === null) {
            return;
        }

        try {
            $learned = $base . '/api/mpesa/callback';

            /*
             * Compared against what is stored, not against what is resolved.
             *
             * When this request arrives through the tunnel, the resolved value
             * already is the tunnel - so comparing resolved-against-derived
             * would always match and never write anything, and the address would
             * be forgotten the moment the operator went back to localhost.
             */
            $stored = trim((string) (Settings::get('mpesa_callback_url') ?? ''));

            if ($stored === $learned) {
                return;
            }

            // A working address somebody chose is never overwritten: there is no
            // way to tell a considered setting from a stale one, so the safe
            // reading is to leave it alone.
            if (self::usable($stored) && !self::isPlaceholder($stored)) {
                return;
            }

            Database::run(
                'INSERT INTO settings (setting_key, setting_value, updated_by)
                 VALUES (?, ?, NULL)
                 ON DUPLICATE KEY UPDATE
                   setting_value = VALUES(setting_value),
                   updated_by = NULL',
                ['mpesa_callback_url', $learned]
            );

            // Both caches: the value was just written, and anything that already
            // read it in this request would otherwise report the old one.
            Settings::forget();
            self::invalidate();
        } catch (\Throwable $e) {
            Log::warn('[mpesa] could not remember the public address: ' . $e->getMessage());
        }
    }

    /**
     * Whether a callback URL could actually receive a Safaricom POST.
     *
     * Registering a placeholder is worse than not registering at all: Safaricom
     * accepts the registration, so the operator believes the paybill is live, and
     * the money then arrives at a URL that answers 404 and the payment is never
     * recorded.
     *
     * localhost counts as unreachable for the same reason - Safaricom is on the
     * internet and has no route to this machine. Reaching the app through a
     * tunnel or a domain is what makes this true, and the status panel says so
     * rather than letting a prompt be refused at the last moment.
     */
    public static function callbackReachable(array $config): bool
    {
        $url = (string) ($config['callbackUrl'] ?? '');

        return $url !== '' && !self::isPlaceholder($url);
    }

    /**
     * Whether a URL is one of the obvious stand-ins rather than a real address.
     *
     * Also covers localhost and the loopback addresses, because Safaricom is on
     * the internet and has no route to this machine: reaching the app through a
     * tunnel or a domain is what makes a callback deliverable.
     */
    private static function isPlaceholder(string $url): bool
    {
        if (preg_match(
            '/your[-_]?domain|example\.(com|org|net)|localhost|127\.0\.0\.1|\[::1\]/i',
            $url
        ) === 1) {
            return true;
        }

        /*
         * Cloudflare's API domain is not a tunnel.
         *
         * A quick tunnel that fails to start logs a request to
         * api.trycloudflare.com, and anything matching a trycloudflare address
         * reads that as though it were the tunnel's name. The result looks like
         * a perfectly good public https URL, so it gets reported reachable while
         * confirmations go to an endpoint that cannot receive them.
         *
         * Excluded here as well as in the script that discovers addresses,
         * because this is the check the operator reads, and it must never say
         * "Safaricom can reach this" about something it cannot.
         */
        return preg_match('#^(https?://)?(api|www)\.trycloudflare\.com#i', $url) === 1;
    }


    /** Drops the cache so a newly saved value is picked up at once. */
    public static function invalidate(): void
    {
        self::$cache = null;
        self::$cachedAt = 0;
    }
}