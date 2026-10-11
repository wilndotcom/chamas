<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Database;
use TheTeam\Log;
use TheTeam\Request;
use TheTeam\Response;

/**
 * Chama branding: the logo.
 *
 * A port of backend/controllers/chamaController.js.
 *
 * The logo is stored as raw image bytes in chama_profile and served back over
 * GET /api/chama/logo. Storing bytes rather than a file path means a deployment
 * needs no writable upload directory and no extra server rule, and the logo
 * survives a rebuild - which matters on shared hosting, where a separate
 * uploads folder is one more thing to configure and one more thing to lose.
 *
 * Uploads arrive as base64 in JSON rather than multipart, which keeps the
 * dependency list unchanged and means the browser can preview the result before
 * anything is sent.
 *
 * The name is NOT handled here. It lives in settings.chama_name and is already
 * exposed by /api/settings/public.
 */
final class ChamaController
{
    /** A logo should never need more than half a megabyte. */
    public const MAX_BYTES = 512 * 1024;

    /**
     * What that costs once base64 encoded, with a little room.
     *
     * Written out rather than computed, because a class constant cannot call
     * ceil(). The value is 512KB * 4/3, rounded up, plus a margin for padding.
     */
    private const MAX_BASE64_CHARS = 699051 + 16;

    /**
     * Detects the real image type from its magic bytes.
     *
     * The browser-supplied MIME type is a hint from an untrusted client and is
     * ignored for validation: a renamed executable would otherwise pass. This is
     * the check that matters, because the bytes are served back to every browser
     * that loads the app.
     */
    public static function sniffImage(string $bytes): ?string
    {
        if (strlen($bytes) < 12) {
            return null;
        }

        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if (str_starts_with($bytes, "\x89PNG\r\n\x1a\n")) {
            return 'image/png';
        }

        // JPEG: FF D8 FF
        if (str_starts_with($bytes, "\xFF\xD8\xFF")) {
            return 'image/jpeg';
        }

        $head = substr($bytes, 0, 6);

        if ($head === 'GIF87a' || $head === 'GIF89a') {
            return 'image/gif';
        }

        // WebP: "RIFF" .... "WEBP"
        if (substr($bytes, 0, 4) === 'RIFF' && substr($bytes, 8, 4) === 'WEBP') {
            return 'image/webp';
        }

        return null;
    }

    /** Public: whether a logo is set, and when it last changed. */
    public static function getProfile(Request $r): void
    {
        try {
            $row = Database::one(
                'SELECT logo_mime, logo_updated_at FROM chama_profile WHERE id = 1'
            ) ?? [];

            Response::json([
                'has_logo' => !empty($row['logo_mime']),
                'mime' => $row['logo_mime'] ?? null,
                'updated_at' => $row['logo_updated_at'] ?? null,
                'logo_url' => !empty($row['logo_mime']) ? '/api/chama/logo' : null,
            ]);
        } catch (\Throwable $e) {
            Log::warn('getChamaProfile: ' . $e->getMessage());
            Response::error('Failed to read the chama profile.', 500);
        }
    }

    /**
     * Public: the logo bytes.
     *
     * Cached hard, because the URL never changes for a given logo and the
     * response carries its own freshness value. ?v= busts it after an upload.
     */
    public static function getLogo(Request $r): void
    {
        try {
            $row = Database::one(
                'SELECT logo_data, logo_mime, logo_updated_at FROM chama_profile WHERE id = 1'
            );

            if ($row === null || empty($row['logo_data'])) {
                Response::error('No logo set.', 404);
            }

            $bytes = base64_decode((string) $row['logo_data'], true);

            if ($bytes === false || $bytes === '') {
                Response::error('No logo set.', 404);
            }

            http_response_code(200);
            header('Content-Type: ' . ($row['logo_mime'] ?: 'application/octet-stream'));
            header('Content-Length: ' . strlen($bytes));
            header('Cache-Control: public, max-age=86400');

            if (!empty($row['logo_updated_at'])) {
                $timestamp = strtotime((string) $row['logo_updated_at']);
                if ($timestamp !== false) {
                    header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $timestamp) . ' GMT');
                }
            }

            // Sent with the type sniffed at upload rather than whatever the
            // client claimed, so the browser never renders an untrusted type.
            header('X-Content-Type-Options: nosniff');

            echo $bytes;
            exit;
        } catch (\Throwable $e) {
            Log::warn('getChamaLogo: ' . $e->getMessage());
            Response::error('Failed to read the logo.', 500);
        }
    }

    /** Admin: store a new logo. */
    public static function uploadLogo(Request $r): void
    {
        try {
            $body = $r->body();
            $data = $body['data'] ?? null;

            if (!$data) {
                Response::error('No image was sent.', 400);
            }

            // A data URL carries the type in front of the payload. Stripped, since
            // the type is sniffed from the bytes anyway.
            $base64 = str_contains((string) $data, ',')
                ? explode(',', (string) $data)[count(explode(',', (string) $data)) - 1]
                : (string) $data;

            if (preg_match('~^[A-Za-z0-9+/=[:space:]]+$~', $base64) !== 1) {
                Response::error('That file is not a readable image.', 400);
            }

            $bytes = base64_decode($base64, true);

            if ($bytes === false || $bytes === '') {
                Response::error('That file appears to be empty.', 400);
            }

            if (strlen($bytes) > self::MAX_BYTES) {
                Response::error(sprintf(
                    'Logo is %dKB. Keep it under 512KB - resizing it usually gets it under 50KB.',
                    (int) round(strlen($bytes) / 1024)
                ), 400);
            }

            $mime = self::sniffImage($bytes);

            if ($mime === null) {
                Response::error('Only PNG, JPEG, GIF and WebP images are accepted.', 400);
            }

            $encoded = base64_encode($bytes);

            if (strlen($encoded) > self::MAX_BASE64_CHARS) {
                Response::error('Logo is too large.', 400);
            }

            Database::run(
                <<<'SQL'
                    INSERT INTO chama_profile (id, logo_data, logo_mime, logo_filename, logo_updated_at)
                    VALUES (1, ?, ?, ?, NOW())
                    ON DUPLICATE KEY UPDATE
                      logo_data = VALUES(logo_data),
                      logo_mime = VALUES(logo_mime),
                      logo_filename = VALUES(logo_filename),
                      logo_updated_at = NOW()
                    SQL,
                [$encoded, $mime, mb_substr((string) ($body['filename'] ?? 'logo'), 0, 255)]
            );

            Response::json([
                'success' => true,
                'mime' => $mime,
                'bytes' => strlen($bytes),
                'message' => 'Logo saved. It now appears in the header, sidebar and sign-in screen.',
            ]);
        } catch (\Throwable $e) {
            Log::warn('uploadChamaLogo: ' . $e->getMessage());
            Response::error('Failed to save the logo.', 500);
        }
    }

    /** Admin: remove the logo and fall back to the built-in mark. */
    public static function deleteLogo(Request $r): void
    {
        try {
            Database::run(
                'UPDATE chama_profile
                    SET logo_data = NULL, logo_mime = NULL, logo_filename = NULL, logo_updated_at = NULL
                  WHERE id = 1'
            );

            Response::json(['success' => true, 'message' => 'Logo removed.']);
        } catch (\Throwable $e) {
            Log::warn('deleteChamaLogo: ' . $e->getMessage());
            Response::error('Failed to remove the logo.', 500);
        }
    }
}