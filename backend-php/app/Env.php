<?php

declare(strict_types=1);

namespace TheTeam;

/**
 * Environment loading, matching backend/config/env.js.
 *
 * The Node version reads the file matching NODE_ENV first so that a production
 * server picks up .env.production, then loads the other purely to fill gaps.
 * Same order here, because a port that quietly loaded the wrong file would boot
 * against the wrong database and that is not a failure anyone notices quickly.
 */
final class Env
{
    /** @var bool[] Roots already read, so a second load of the same one is a no-op. */
    private static array $loadedRoots = [];

    /** Remembers which files were read, for the startup banner. */
    private static array $loadedFiles = [];

    /**
     * Every directory that was searched, whether or not it had a .env.
     *
     * Reported when nothing is found. "No .env" alone is not enough to act on -
     * the usual cause is a path that resolves somewhere unexpected, and naming
     * the directories is the difference between a two-second fix and an
     * afternoon. That exact failure happened during this port: a derived path
     * kept its '/../', so dirname() returned public/ and every lookup missed
     * while the app still booted.
     *
     * @var string[]
     */
    private static array $searchedPaths = [];

    /**
     * The timezone the database stores its timestamps in.
     *
     * mysql2 hands DATETIME columns back to JavaScript as Date objects, which
     * JavaScript then reads as UTC. A value written as 2026-10-04 00:00:00 in
     * Nairobi arrives in the Node version as 2026-10-03T21:00:00Z and renders in
     * the browser as the 3rd, not the 4th.
     *
     * That is a long-standing bug in the Node version, and reproducing it in PHP
     * would be faithful rather than correct. It is fixed here instead - see
     * Database::setUpConnection - and the difference is listed in DEPLOYMENT.md
     * so it is a decision on record rather than a surprise. The day a member
     * joined is the kind of figure they remember and check.
     */
    public static function getDatabaseTimezone(): string
    {
        return self::get('DB_TIMEZONE', 'Africa/Nairobi');
    }

    /**
     * Loads the .env in a directory.
     *
     * Callable more than once with different roots: the first root loaded wins,
     * because readDotEnv leaves a real environment variable and anything it has
     * already set alone. That is what lets the port-specific config override the
     * shared one without either copy having to know about the other.
     */
    public static function load(string $root): void
    {
        $root = rtrim(str_replace('\\', '/', $root), '/');

        if (isset(self::$loadedRoots[$root])) {
            return;
        }
        self::$loadedRoots[$root] = true;
        self::$searchedPaths[] = $root;

        $isProd = (self::raw('NODE_ENV') ?: 'development') === 'production';
        $primary = $isProd ? '.env.production' : '.env';
        $fallback = $isProd ? '.env' : '.env.production';

        foreach ([$primary, $fallback] as $name) {
            $file = $root . '/' . $name;
            if (is_file($file)) {
                self::readDotEnv($file);
                self::$loadedFiles[] = $root . '/' . $name;
            }
        }
    }

    /** Finishes loading and reports what was found. */
    public static function finish(): void
    {
        if (self::$loadedFiles === []) {
            Log::warn('No .env or .env.production found. The app cannot reach the database '
                . 'without one. Looked in: ' . implode(', ', self::$searchedPaths));
            return;
        }

        foreach (self::$loadedFiles as $file) {
            Log::startup('env: loaded ' . $file);
        }

        $critical = ['DB_NAME', 'JWT_SECRET'];
        foreach ($critical as $key) {
            if (self::get($key) === null) {
                Log::warn("{$key} is not set. Login will fail and the database will not connect.");
            }
        }
    }

    /**
     * Minimal .env parser.
     *
     * Written by hand rather than pulled in, so there is one less dependency
     * whose behaviour has to be trusted. Handles the forms this project's own
     * files actually use: KEY=value, quoted values, # comments, blank lines.
     * Existing environment variables win, matching dotenv.
     */
    private static function readDotEnv(string $path): void
    {
        $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if ($lines === false) {
            return;
        }

        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#')) {
                continue;
            }

            $eq = strpos($line, '=');
            if ($eq === false) {
                continue;
            }

            $key = trim(substr($line, 0, $eq));
            $value = trim(substr($line, $eq + 1));

            if (getenv($key) !== false) {
                continue; // a real environment variable always beats the file
            }

            // Strip surrounding quotes, and an inline comment only after a value
            // that is unquoted - inside quotes a # is part of the value.
            $len = strlen($value);
            if ($len >= 2 && ($value[0] === '"' || $value[0] === "'") && $value[$len - 1] === $value[0]) {
                $value = substr($value, 1, -1);
            } else {
                $hash = strpos($value, ' #');
                if ($hash !== false) {
                    $value = rtrim(substr($value, 0, $hash));
                }
            }

            putenv($key . '=' . $value);
            $_ENV[$key] = $value;
            $_SERVER[$key] = $value;
        }
    }

    public static function get(string $key, ?string $default = null): ?string
    {
        $value = getenv($key);
        if ($value === false || $value === '') {
            return $default;
        }
        return $value;
    }

    public static function int(string $key, int $default): int
    {
        $value = getenv($key);
        return ($value === false || $value === '') ? $default : (int) $value;
    }

    public static function bool(string $key, bool $default = false): bool
    {
        $value = getenv($key);
        if ($value === false || $value === '') {
            return $default;
        }
        return in_array(strtolower($value), ['1', 'true', 'yes', 'on'], true);
    }

    private static function raw(string $key): ?string
    {
        $value = getenv($key);
        return $value === false ? null : $value;
    }
}