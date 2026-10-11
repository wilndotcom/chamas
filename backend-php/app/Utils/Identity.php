<?php

declare(strict_types=1);

namespace TheTeam\Utils;

/**
 * Build and installation identity.
 *
 * A port of backend/config/version.js and backend/utils/identity.js.
 *
 * The install id identifies an *installation*, not a person. It is generated
 * locally and never derived from member data.
 *
 * What this is for
 *   - telling a bug report against 1.0.0 apart from one against someone's fork
 *   - letting the developer confirm which build a client is running
 *
 * What this is NOT
 *   - it does not phone home. Nothing leaves the machine unless the operator
 *     configures a reporting endpoint themselves.
 *   - it carries no member names, phone numbers or financial figures.
 *
 * Report it when asked, or when the operator has deliberately enabled
 * WILNCOM_REPORT_URL. Reporting is opt-in and disclosed in Settings.
 */

use TheTeam\Database;
use TheTeam\Env;
use TheTeam\Log;

final class Identity
{
    private static ?string $installId = null;

    /**
     * The install id, generated on first boot and stored in settings.
     *
     * Stored rather than generated per boot so it survives restarts, rebuilds
     * and upgrades - which is the whole point of having one. A fresh id per boot
     * would mean two reports of the same installation look unrelated.
     */
    public static function installId(): string
    {
        if (self::$installId !== null) {
            return self::$installId;
        }

        try {
            $stored = Database::scalar(
                "SELECT setting_value FROM settings WHERE setting_key = 'install_id'"
            );

            if ($stored !== null && trim((string) $stored) !== '') {
                return self::$installId = (string) $stored;
            }

            $generated = self::uuid();

            // ON DUPLICATE with a no-op update: a second process racing this one
            // should keep whatever landed first rather than overwriting it, since
            // both are valid but only one should ever be the install's id.
            Database::run(
                <<<'SQL'
                    INSERT INTO settings (setting_key, setting_value, description)
                    VALUES ('install_id', ?, 'Unique id for this installation. Generated locally on first boot.')
                    ON DUPLICATE KEY UPDATE setting_value = setting_value
                    SQL,
                [$generated]
            );

            // Re-read rather than trusting the write: the race above may have
            // kept somebody else's value, and that is the one to report.
            $final = Database::scalar(
                "SELECT setting_value FROM settings WHERE setting_key = 'install_id'"
            );

            return self::$installId = (string) ($final ?? $generated);
        } catch (\Throwable $e) {
            // Identity is a convenience, never a hard dependency. A fresh id per
            // boot is harmless, so this must not stop Settings from loading.
            Log::warn('[identity] could not read install_id: ' . $e->getMessage());
            return self::$installId = 'ephemeral-' . self::uuid();
        }
    }

    /**
     * Everything needed to recognise a build, and nothing that identifies a member.
     *
     * @param int $memberCount how many members are on file, as an aggregate
     */
    public static function buildInfo(int $memberCount = 0): array
    {
        return [
            'app' => 'THE TEAM',
            'version' => self::version(),
            'build' => self::buildId(),
            'install_id' => self::installId(),

            // Aggregate only. Never names, phone numbers, balances or savings
            // totals.
            'member_count' => $memberCount,

            'licence' => 'Non-Commercial MIT (see LICENSE)',
        ];
    }

    /**
     * The application version.
     *
     * Read from composer.json rather than duplicated as a constant, so the two
     * cannot disagree and report a build number that was never shipped.
     */
    public static function version(): string
    {
        try {
            $composer = json_decode(
                (string) @file_get_contents(dirname(__DIR__, 2) . '/composer.json'),
                true
            );

            $version = $composer['extra']['app_version'] ?? null;

            if (is_string($version) && $version !== '') {
                return $version;
            }
        } catch (\Throwable) {
            // Falls through to the default below.
        }

        return '1.0.0';
    }

    /**
     * Which build this is.
     *
     * BUILD_ID should be stamped at deploy time from the commit being shipped.
     * Without it the date is used, which is weaker: two deployments on the same
     * day look identical.
     */
    public static function buildId(): string
    {
        return Env::get('BUILD_ID') ?? ('local-' . gmdate('Ymd'));
    }

    /**
     * A RFC 4122 version 4 UUID.
     *
     * Written out rather than pulled from a library: random_bytes() is in core,
     * and the format is short enough that a dependency would be more code than
     * this. Cryptographically random, because this value is a credential of sorts
     * - two installations that shared one would look like the same installation.
     */
    private static function uuid(): string
    {
        $bytes = random_bytes(16);

        // Version 4, variant 1.
        $bytes[6] = chr((ord($bytes[6]) & 0x0F) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3F) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}