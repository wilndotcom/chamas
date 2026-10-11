<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Database;
use TheTeam\Log;
use TheTeam\Request;
use TheTeam\Response;

/**
 * Per-user interface language.
 *
 * A port of backend/controllers/preferencesController.js.
 *
 * The `language` setting in Settings is the chama-wide default. This is the
 * individual override: a member who reads Kiswahili and an admin who does not can
 * both be served correctly instead of one forcing it on the other.
 *
 * null means "no opinion", which falls back to the global setting. That is why
 * the column is nullable and why clearing it is a valid request rather than an
 * error - "I have no preference" is a real answer.
 */
final class PreferencesController
{
    /** The same list the frontend dictionary defines. */
    public const SUPPORTED = ['en', 'sw'];

    /**
     * The table holding the signed-in account.
     *
     * From a whitelist, never from the token directly. Building a table name out
     * of a value inside a token would mean a forged claim chose which table was
     * read, and the token is unverified input until the signature is checked.
     */
    private static function tableFor(?array $user): ?string
    {
        return match ($user['type'] ?? null) {
            'admin' => 'admins',
            'member' => 'members',
            default => null,
        };
    }

    /** Reads the signed-in user's language, or null when they have not chosen one. */
    public static function getMyLanguage(Request $r): void
    {
        try {
            $table = self::tableFor($r->user);

            if ($table === null) {
                Response::error('Unknown account type.', 403);
            }

            $row = Database::one("SELECT language FROM {$table} WHERE id = ?", [$r->user['id']]);

            if ($row === null) {
                Response::error('Account not found.', 404);
            }

            Response::json([
                'language' => $row['language'] ?: null,
                'supported' => self::SUPPORTED,
            ]);
        } catch (\Throwable $e) {
            Log::warn('getMyLanguage: ' . $e->getMessage());
            Response::error('Failed to read your language preference.', 500);
        }
    }

    /**
     * Saves the signed-in user's language.
     *
     * Sending null clears the override so the user follows the chama-wide setting
     * again.
     */
    public static function setMyLanguage(Request $r): void
    {
        try {
            $table = self::tableFor($r->user);

            if ($table === null) {
                Response::error('Unknown account type.', 403);
            }

            $language = $r->body()['language'] ?? null;

            if ($language !== null && !in_array($language, self::SUPPORTED, true)) {
                // A code without a translation would be accepted by the database
                // but silently fall back to English, leaving the picker blank -
                // so it is refused with the valid choices named.
                Response::error(sprintf(
                    'Language must be one of: %s, or empty to follow the group default.',
                    implode(', ', self::SUPPORTED)
                ), 400);
            }

            $value = $language ?: null;

            $exists = Database::one("SELECT id FROM {$table} WHERE id = ?", [$r->user['id']]);

            if ($exists === null) {
                Response::error('Account not found.', 404);
            }

            Database::run("UPDATE {$table} SET language = ? WHERE id = ?", [$value, $r->user['id']]);

            Response::json([
                'success' => true,
                'language' => $value,
                'message' => $value
                    ? 'Language saved.'
                    : 'Now following the group default language.',
            ]);
        } catch (\Throwable $e) {
            // The database enforces the list with a CHECK constraint too, so a
            // race between two writers can still reach it. Answered as the same
            // validation error rather than a server fault.
            if ($e instanceof \PDOException && $e->getCode() === '23000') {
                Response::error(sprintf(
                    'Language must be one of: %s.',
                    implode(', ', self::SUPPORTED)
                ), 400);
            }

            Log::warn('setMyLanguage: ' . $e->getMessage());
            Response::error('Failed to save your language preference.', 500);
        }
    }
}