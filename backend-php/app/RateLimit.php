<?php

declare(strict_types=1);

namespace TheTeam;

/**
 * Rate limiting.
 *
 * Replaces express-rate-limit. Counters are per IP per window, held in APCu when
 * available and in a file otherwise - the same in-memory-per-process model the
 * Node version uses, so the behaviour matches rather than being "better" in a
 * way that would differ between the two ports.
 *
 * A single-file counter store is used rather than a database table so that
 * limiting a request never touches the tables holding real money records.
 */
final class RateLimit
{
    /** Counters older than this are swept, so the store cannot grow forever. */
    private const SWEEP_AFTER = 3600;

    private static string $dir = '';

    public static function init(string $dir): void
    {
        self::$dir = rtrim($dir, '/') . '/rate';
        if (!is_dir(self::$dir)) {
            @mkdir(self::$dir, 0775, true);
        }
    }

    /**
     * Counts one hit and reports whether it is allowed.
     *
     * @param string $bucket Grouping, so login and password reset do not share
     *                       one budget and a locked-out reseter does not stop
     *                       anyone signing in.
     */
    public static function hit(string $bucket, string $ip, int $max, int $windowSeconds): bool
    {
        $key = $bucket . ':' . md5($ip);
        $now = time();

        $count = self::increment($key, $now, $windowSeconds);

        self::sweep($now);

        return $count <= $max;
    }

    private static function increment(string $key, int $now, int $window): int
    {
        if (function_exists('apcu_fetch') && ini_get('apc.enabled')) {
            $entry = apcu_fetch($key, $ok);
            if ($ok === false || !is_array($entry) || $entry['reset'] <= $now) {
                $entry = ['count' => 0, 'reset' => $now + $window];
            }
            $entry['count']++;
            apcu_store($key, $entry, $window + 60);
            return $entry['count'];
        }

        $file = self::file($key);
        $entry = ['count' => 0, 'reset' => $now + $window];

        // Opened exclusively: two simultaneous requests must not both read a
        // zero count and both write one, which would halve the real limit.
        $handle = @fopen($file, 'c+');
        if ($handle === false) {
            // If the store cannot be written, allow the request. Failing closed
            // here would lock everyone out of a filesystem problem.
            return 1;
        }

        if (flock($handle, LOCK_EX)) {
            $raw = stream_get_contents($handle) ?: '';
            $decoded = json_decode($raw, true);
            if (is_array($decoded) && ($decoded['reset'] ?? 0) > $now) {
                $entry = ['count' => $decoded['count'] + 1, 'reset' => $decoded['reset']];
            }
            ftruncate($handle, 0);
            rewind($handle);
            fwrite($handle, json_encode($entry));
            fflush($handle);
            flock($handle, LOCK_UN);
            $count = $entry['count'];
        } else {
            $count = 1;
        }

        fclose($handle);
        return $count;
    }

    /** Removes expired counters occasionally, so the directory stays small. */
    private static function sweep(int $now): void
    {
        // One sweep in a hundred hits is plenty and costs nothing measurable.
        if (random_int(1, 100) !== 1) {
            return;
        }

        foreach (glob(self::$dir . '/*.json') ?: [] as $file) {
            if (@filemtime($file) < $now - self::SWEEP_AFTER) {
                @unlink($file);
            }
        }
    }

    private static function file(string $key): string
    {
        return self::$dir . '/' . $key . '.json';
    }
}