<?php

declare(strict_types=1);

namespace TheTeam;

/**
 * JSON responses.
 *
 * Every endpoint returns JSON, including errors, because the React frontend
 * parses whatever it gets as JSON. A PHP notice printed into the output would
 * arrive as malformed JSON and surface as a confusing parse failure rather than
 * the actual problem.
 *
 * `json()` is the only way a controller should answer. Nothing echoes.
 */
final class Response
{
    public static function json($data, int $status = 200): void
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json; charset=utf-8');
        }
        echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }

    public static function ok($data = null): void
    {
        self::json($data ?? ['success' => true]);
    }

    public static function error(string $message, int $status = 400, array $extra = []): void
    {
        self::json(array_merge(['error' => $message], $extra), $status);
    }

    /**
     * HTML for the app shell.
     *
     * Only the SPA fallback uses this, to return index.html for an address the
     * app routes internally. Serving it for an unknown /api path would hand a
     * caller an HTML page where it expected JSON, so the router never does that.
     */
    public static function html(string $file): void
    {
        if (!headers_sent()) {
            http_response_code(200);
            header('Content-Type: text/html; charset=utf-8');
            header('Cache-Control: no-cache, no-store, must-revalidate');
        }
        readfile($file);
        exit;
    }
}