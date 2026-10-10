<?php

declare(strict_types=1);

/**
 * The React app.
 *
 * Anything that is not an API call and not a real file is handed to index.html,
 * so the router on the client can resolve it. Mirrors the SPA fallback in the
 * Node server.js, including the same exclusion: an unknown /api address gets a
 * JSON 404, never an HTML page, because a caller expecting JSON that receives
 * HTML reports a parse error rather than the missing route that actually caused
 * it.
 */

use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Router;

return function (Router $router): void {
    $dist = dirname(__DIR__, 2) . '/frontend/dist';

    $router->get('/', function (Request $r) use ($dist) {
        if (!is_file($dist . '/index.html')) {
            Response::json([
                'error' => 'Frontend not built.',
                'detail' => 'Run "npm run build" in the frontend folder, or use the Vite dev server.',
            ], 503);
        }
        Response::html($dist . '/index.html');
    });

    /*
     * The SPA fallback.
     *
     * Registered for every method, not just GET: a client-side route can be
     * reached by a form POST or a bookmarked PUT target, and answering 405 for
     * those shows a browser error page instead of the app. Guarded by the /api
     * check below so a missing API endpoint is still a JSON 404.
     *
     * Registered last, so every real route wins over it.
     */
    $fallback = function (Request $r) use ($dist) {
        // Never answer an API path with the app shell. An /api address that
        // matched no route is a missing endpoint, not a client-side route, and
        // handing back HTML makes the frontend report a JSON parse error that
        // says nothing about the real cause.
        if (str_starts_with($r->path(), '/api/')) {
            Response::error('Route not found', 404);
        }

        if (!is_file($dist . '/index.html')) {
            Response::json([
                'error' => 'Frontend not built.',
                'detail' => 'Run "npm run build" in the frontend folder, or use the Vite dev server.',
            ], 503);
        }

        Response::html($dist . '/index.html');
    };

    foreach (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as $verb) {
        $router->add($verb, '/*', $fallback);
    }
};