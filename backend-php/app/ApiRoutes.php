<?php

declare(strict_types=1);

namespace TheTeam;

use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Router;

/**
 * Tracks which API groups are actually mounted.
 *
 * While the PHP port is incomplete this answers, rather than hides, what is
 * missing. An unported group returns an explicit 501 naming itself, where a
 * missing route would return 404 and read as a bug in working code.
 */
final class ApiRoutes
{
    /** @var string[] Prefixes that have no file yet. */
    private static array $pending = [];

    /** @var string[] Prefixes that loaded successfully. */
    private static array $mounted = [];

    public static function mount(Router $router, string $prefix, string $file): void
    {
        $register = require $file;
        $register($router, $prefix);
        self::$mounted[] = $prefix;
    }

    /**
     * Registers a stand-in for a group that has not been ported yet.
     *
     * It answers 501 and names the group, so the failure points at the missing
     * work instead of at whatever frontend feature happens to call it first.
     */
    public static function pending(Router $router, string $prefix): void
    {
        self::$pending[] = $prefix;

        $router->get($prefix . '/*', static function (Request $r) use ($prefix) {
            Response::json([
                'error' => 'This endpoint group has not been ported to PHP yet.',
                'group' => $prefix,
            ], 501);
        });
    }

    /** @return string[] */
    public static function pendingGroups(): array
    {
        return self::$pending;
    }

    /** @return string[] */
    public static function mountedGroups(): array
    {
        return self::$mounted;
    }
}