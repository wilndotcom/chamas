<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Auth;
use TheTeam\Database;
use TheTeam\Log;
use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Utils\Identity;
use TheTeam\Utils\MpesaConfig;
use TheTeam\Utils\Settings;
use TheTeam\Utils\SettingsSchema;

/**
 * Settings: reading, validating and saving them.
 *
 * A port of backend/controllers/settingsController.js, with the validation rules
 * living in Utils\SettingsSchema.
 *
 * Two things are enforced here rather than trusted from the client:
 *
 * Only allowlisted keys can be written. Roles and permissions are in their own
 * tables and are not settings at all; letting a request write them would mean
 * editing rows the API does not validate.
 *
 * Secrets are never returned and never destroyed by a read-and-save round trip.
 * A read replaces each one with a mask, and a write treats that mask as "leave
 * this alone". Without the second half, saving an unrelated field on the same
 * card would replace a working M-Pesa passkey with eight characters.
 */
final class SettingsController
{
    /**
     * Every setting, with credentials masked.
     *
     * The list of secret keys is sent to the client rather than left for it to
     * infer from the mask, so a screen cannot accidentally render the sentinel
     * as a real value.
     */
    public static function getAllSettings(Request $r): void
    {
        try {
            $settings = Database::all('SELECT * FROM settings ORDER BY setting_key');

            $settings = array_map(static function (array $row): array {
                $key = (string) $row['setting_key'];

                // An unset secret stays unset, so the screen can still tell "not
                // configured yet" from "configured and hidden".
                if (SettingsSchema::isSecret($key) && trim((string) ($row['setting_value'] ?? '')) !== '') {
                    $row['setting_value'] = SettingsSchema::SECRET_MASK;
                }

                return $row;
            }, $settings);

            Response::json([
                'settings' => $settings,
                'secret_keys' => SettingsSchema::secretKeys(),
            ]);
        } catch (\Throwable $e) {
            Log::warn('getAllSettings: ' . $e->getMessage());
            Response::error('Failed to fetch settings.', 500);
        }
    }

    /**
     * Saves several settings in one transaction.
     *
     * One request per card rather than one per field: a partially-applied save is
     * worse than a failed one, because the operator cannot tell which half stuck.
     * Either every key is written or none is.
     */
    public static function updateSettings(Request $r): void
    {
        $values = $r->body()['values'] ?? null;

        if (!is_array($values) || $values === [] || array_is_list($values)) {
            Response::error('Send { values: { key: value } }.', 400);
        }

        $keys = array_keys($values);

        if ($keys === []) {
            Response::error('Nothing to save.', 400);
        }

        $rejected = array_values(array_filter($keys, static fn($k) => !SettingsSchema::isEditable((string) $k)));

        if ($rejected !== []) {
            Response::error(
                'These settings cannot be changed here: ' . implode(', ', $rejected),
                400
            );
        }

        // Every key validated before the transaction opens, so a bad value cannot
        // leave half a card applied.
        foreach ($keys as $key) {
            $result = self::validate((string) $key, $values[$key] ?? null);
            if (empty($result['ok'])) {
                Response::error($result['error'], 400);
            }
        }

        try {
            $written = 0;
            $kept = 0;

            Database::transaction(function ($pdo) use ($keys, $values, $r, &$written, &$kept): void {
                $statement = $pdo->prepare(
                    <<<'SQL'
                        INSERT INTO settings (setting_key, setting_value, updated_by)
                        VALUES (?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                          setting_value = VALUES(setting_value),
                          updated_by = VALUES(updated_by)
                        SQL
                );

                foreach ($keys as $key) {
                    $result = self::validate((string) $key, $values[$key] ?? null);

                    // An untouched secret is left alone rather than written, so
                    // saving an unrelated field on the same card cannot destroy a
                    // working credential.
                    if (!empty($result['keep'])) {
                        $kept++;
                        continue;
                    }

                    $statement->execute([$key, $result['value'], $r->user['id']]);
                    $written++;
                }
            });

            // A key saved in Settings must be the one the next request uses. The
            // caches held by the readers are dropped here, because a save that
            // appears to do nothing for thirty seconds is indistinguishable from
            // a save that failed.
            self::invalidateCaches($keys);

            Response::json(['success' => true, 'saved' => count($keys), 'keys' => $keys]);
        } catch (\Throwable $e) {
            Log::warn('[settings] bulk save failed: ' . $e->getMessage());
            Response::error('Could not save settings. Nothing was changed.', 500);
        }
    }

    /** Saves one setting. */
    public static function updateSetting(Request $r): void
    {
        try {
            $key = (string) $r->param('key');
            $value = $r->body()['value'] ?? null;

            if (!SettingsSchema::isEditable($key)) {
                Response::error("{$key} cannot be changed from here.", 400);
            }

            $result = self::validate($key, $value);

            if (empty($result['ok'])) {
                Response::error($result['error'], 400);
            }

            // An untouched secret is a no-op, not a write. Without this, reading a
            // credential (which returns the mask) and saving it straight back
            // would replace a working API key with the mask itself.
            if (!empty($result['keep'])) {
                Response::json(['success' => true, 'key' => $key, 'unchanged' => true]);
            }

            /*
             * Existence checked first, then updated.
             *
             * Counting affected rows does not work for this. MySQL reports zero
             * rows affected both when there is no such row *and* when the value
             * was already exactly what was saved - so saving a setting to the
             * value it already holds returned "No setting called X exists", which
             * is how a real setting became impossible to re-save from the single
             * field endpoint.
             */
            $exists = Database::scalar(
                'SELECT setting_key FROM settings WHERE setting_key = ?',
                [$key]
            );

            if ($exists === null) {
                // Named because the alternative - reporting success while writing
                // nothing - is how a field could look saved and never persist.
                Response::error("No setting called {$key} exists.", 404);
            }

            Database::run(
                'UPDATE settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?',
                [$result['value'], $r->user['id'], $key]
            );

            self::invalidateCaches([$key]);

            Response::json(['success' => true, 'key' => $key, 'value' => $result['value']]);
        } catch (\Throwable $e) {
            Log::warn('[settings] update failed: ' . $e->getMessage());
            Response::error('Failed to update setting.', 500);
        }
    }

    /**
     * Public settings.
     *
     * Readable without authentication because the client needs them to format
     * every amount on screen. Nothing sensitive is exposed here - the key list is
     * written out rather than filtered from the full table, so a credential added
     * later cannot leak by being forgotten.
     */
    public static function getPublicSettings(Request $r): void
    {
        try {
            $public = [
                'chama_name', 'monthly_contribution', 'welfare_contribution',
                'language', 'currency', 'currency_symbol',
                'symbol_position', 'decimal_separator', 'thousand_separator',
                'theme', 'color_mode',
            ];

            $placeholders = implode(',', array_fill(0, count($public), '?'));

            $rows = Database::all(
                "SELECT setting_key, setting_value FROM settings
                  WHERE setting_key IN ({$placeholders})",
                $public
            );

            Response::json(['settings' => $rows]);
        } catch (\Throwable $e) {
            Log::warn('getPublicSettings: ' . $e->getMessage());
            Response::error('Failed to fetch settings.', 500);
        }
    }

    /**
     * Build and licence identity, for the Settings "About" panel.
     *
     * Lets an operator confirm which build they are running and gives the
     * developer a reference when triaging a report. The install id is generated
     * locally on first boot; nothing is sent anywhere.
     */
    public static function getAbout(Request $r): void
    {
        try {
            $memberCount = (int) Database::scalar('SELECT COUNT(*) FROM members');

            Response::json(array_merge(
                Identity::buildInfo($memberCount),
                [
                    'booted_at' => gmdate('c'),

                    // Reporting stays off unless the operator supplies their own
                    // endpoint.
                    'reporting_configured' => \TheTeam\Env::get('WILNCOM_REPORT_URL') !== null,

                    'reporting_disclosure' =>
                        'No data is sent anywhere unless WILNCOM_REPORT_URL is set on this '
                        . 'server. Even then it carries only version, build id, install id and a '
                        . 'member count - never member names, phone numbers or money.',
                ]
            ));
        } catch (\Throwable $e) {
            Log::warn('getAbout: ' . $e->getMessage());
            Response::error('Failed to load build information.', 500);
        }
    }

    // ---------------------------------------------------------------- helpers

    /**
     * Validates one value.
     *
     * @return array{ok:bool, value?:string, keep?:bool, error?:string}
     */
    private static function validate(string $key, $raw): array
    {
        if ($raw === null) {
            return ['ok' => true, 'value' => ''];
        }

        $value = (string) $raw;

        // A card save carries every field on it, so an untouched secret arrives as
        // the mask. Recognised here and reported separately, because writing it
        // would replace a working credential with eight characters.
        if (SettingsSchema::isSentinel($value)) {
            return ['ok' => true, 'value' => null, 'keep' => true];
        }

        // Checked here so a bad address is refused on save with a message naming
        // the field, instead of being stored and failing on the next send.
        if (str_ends_with($key, '_endpoint')) {
            $problem = SettingsSchema::validateCustomEndpoint($key, $value);
            if ($problem !== null) {
                return ['ok' => false, 'error' => $problem];
            }
        }

        // A body that cannot be parsed as JSON, even with the placeholders
        // substituted, would be rejected by the endpoint at send time.
        if (str_ends_with($key, '_body') && $value !== '') {
            $probe = str_replace(
                ['{{phone}}', '{{message}}', '{{from}}'],
                ['254712345678', 'x', 'THE_TEAM'],
                $value
            );

            json_decode($probe);

            if (json_last_error() !== JSON_ERROR_NONE) {
                return [
                    'ok' => false,
                    'error' => sprintf(
                        '%s is not valid JSON: %s. It must be a JSON object such as '
                        . '{"to":"{{phone}}","message":"{{message}}"}.',
                        $key,
                        json_last_error_msg()
                    ),
                ];
            }
        }

        $allowed = SettingsSchema::allowedValues();

        if (isset($allowed[$key]) && !in_array($value, $allowed[$key], true)) {
            return [
                'ok' => false,
                'error' => sprintf(
                    '%s must be one of: %s.',
                    SettingsSchema::label($key),
                    implode(', ', $allowed[$key])
                ),
            ];
        }

        $rules = SettingsSchema::numericRules();

        if (!isset($rules[$key])) {
            // 255 is the column width. Truncated rather than rejected so a pasted
            // paragraph does not fail a save the operator was told would work.
            return ['ok' => true, 'value' => mb_substr($value, 0, 255)];
        }

        $rule = $rules[$key];
        $label = SettingsSchema::label($key);

        if ($value === '' || !is_numeric($value)) {
            return ['ok' => false, 'error' => "{$label} must be a number."];
        }

        $n = (float) $value;

        if (!empty($rule['integer']) && floor($n) !== $n) {
            return ['ok' => false, 'error' => "{$label} must be a whole number."];
        }

        // Two decimal places, checked without float arithmetic: 0.1 + 0.2 is not
        // exactly 0.3, and a naive check would reject a value the operator can
        // plainly see is fine.
        if (empty($rule['integer']) && empty($rule['allowDecimal'])
            && !self::hasAtMostTwoDecimals($value)) {
            return ['ok' => false, 'error' => "{$label} may have at most two decimal places."];
        }

        if ($n < $rule['min'] || $n > $rule['max']) {
            return [
                'ok' => false,
                'error' => sprintf(
                    '%s must be between %s and %s.',
                    $label,
                    self::trimNumber($rule['min']),
                    self::trimNumber($rule['max'])
                ),
            ];
        }

        return ['ok' => true, 'value' => $value];
    }

    /**
     * Whether a written number has at most two decimal places.
     *
     * Examined as text rather than as a float, because the question is what the
     * operator typed and a float has already lost the answer.
     */
    private static function hasAtMostTwoDecimals(string $value): bool
    {
        if (!preg_match('/^-?\d+(\.\d+)?$/', trim($value))) {
            return false;
        }

        $parts = explode('.', trim($value), 2);

        return !isset($parts[1]) || strlen(rtrim($parts[1], '0')) <= 2;
    }

    /** Whole numbers without a trailing ".0". */
    private static function trimNumber($value): string
    {
        if (is_float($value) && floor($value) === $value) {
            return (string) (int) $value;
        }

        return (string) $value;
    }

    /**
     * Drops the caches behind the readers, so a saved value takes effect at once.
     *
     * Both the M-Pesa and the notification config are cached for up to thirty
     * seconds in the Node version. Dropping them here is the difference between
     * saving a key and it working, and between saving a key and appearing to do
     * nothing - which is exactly the failure this controller keeps having to be
     * corrected for.
     */
    private static function invalidateCaches(array $keys): void
    {
        // The settings cache itself, always: a change to any of these is a change
        // to what every other controller reads.
        Settings::forget();

        // The M-Pesa config, which is cached for thirty seconds. Dropping it here
        // is the difference between saving a key and it working, and between
        // saving a key and appearing to do nothing.
        $touchesMpesa = false;
        foreach ($keys as $key) {
            if (str_starts_with((string) $key, 'mpesa_')) {
                $touchesMpesa = true;
                break;
            }
        }

        if ($touchesMpesa) {
            MpesaConfig::invalidate();
        }
    }
}