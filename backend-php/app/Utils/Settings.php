<?php

declare(strict_types=1);

namespace TheTeam\Utils;

use TheTeam\Database;

/**
 * Reading settings.
 *
 * A port of getSetting in backend/utils/riskMembers.js, extracted on its own
 * because several controllers need it and none of them need the rest of that
 * file.
 *
 * The cache matters more than it looks. These values are read inside a loop over
 * members on the dashboard, and the loans table has a row for every application
 * - so an uncached read is one extra query per row per page load. It is a
 * per-request cache rather than a shared one: a shared cache would go stale
 * after an admin changes the interest rate, and the next loan applied would be
 * priced on yesterday's number.
 */
final class Settings
{
    /** @var array<string, string|null> Keyed by setting_key. */
    private static array $cache = [];

    /**
     * One setting, or the fallback when it is not set.
     *
     * A stored empty string is returned as-is rather than treated as missing:
     * "the administrator deliberately set this to blank" and "nobody has set
     * this" are different states, and collapsing them means an emptied setting
     * quietly reverts to a default the admin had removed.
     */
    public static function get(string $key, ?string $fallback = null): ?string
    {
        if (array_key_exists($key, self::$cache)) {
            return self::$cache[$key];
        }

        $value = Database::scalar(
            'SELECT setting_value FROM settings WHERE setting_key = ?',
            [$key]
        );

        // Cast so "1" and 1 behave the same to a caller comparing with ===.
        $value = $value === null ? null : (string) $value;

        self::$cache[$key] = $value;

        return $value ?? $fallback;
    }

    /** A setting as a number, or the fallback when absent or unusable. */
    public static function getNumber(string $key, float $fallback): float
    {
        $value = self::get($key);

        return ($value !== null && is_numeric($value)) ? (float) $value : $fallback;
    }

    /** A setting as an integer, or the fallback when absent or unusable. */
    public static function getInt(string $key, int $fallback): int
    {
        $value = self::get($key);

        return ($value !== null && is_numeric($value)) ? (int) $value : $fallback;
    }

    /** A setting as a yes/no, or the fallback when absent. */
    public static function getBool(string $key, bool $fallback = false): bool
    {
        $value = self::get($key);

        if ($value === null) {
            return $fallback;
        }

        return in_array(strtolower(trim($value)), ['1', 'true', 'yes', 'on'], true);
    }

    /**
     * Clears the cache after a write.
     *
     * Called whenever settings change. Without it an admin who changes the
     * interest rate and immediately approves a loan would see the old rate
     * applied, and the member would be charged yesterday's price.
     */
    public static function forget(): void
    {
        self::$cache = [];
    }
}