<?php

declare(strict_types=1);

namespace TheTeam;

/**
 * Logging that works under any SAPI.
 *
 * STDERR and STDOUT are only defined on the CLI. Under the web SAPI - which is
 * how this runs on Apache, and which PHP's built-in server also uses - referring
 * to them throws "Undefined constant", turning a diagnostic into a fatal error.
 *
 * Every write goes to the error log instead, which php.ini routes to the
 * Apache error log or to stderr for the built-in server. Nothing is echoed to
 * the response body, because anything printed there corrupts the JSON the
 * frontend is trying to parse.
 */
final class Log
{
    private static bool $echoToStderr = false;

    /**
     * Turns on direct output to stderr when it is actually available.
     *
     * Called by index.php at boot. Used for the startup banner, which is
     * genuinely useful to see in a terminal but must not be emitted per request.
     */
    public static function useStderr(bool $enabled = true): void
    {
        self::$echoToStderr = $enabled && defined('STDERR');
    }

    /** A diagnostic: something went wrong but the request can still be answered. */
    public static function warn(string $message): void
    {
        error_log('[the-team] ' . $message);
        if (self::$echoToStderr) {
            fwrite(STDERR, '[the-team] ' . $message . "\n");
        }
    }

    /** A startup line, for the terminal only. */
    public static function startup(string $message): void
    {
        if (self::$echoToStderr) {
            fwrite(STDERR, '[the-team] ' . $message . "\n");
            return;
        }
        error_log('[the-team] ' . $message);
    }
}