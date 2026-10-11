<?php

declare(strict_types=1);

namespace TheTeam;

/**
 * Front controller.
 *
 * Every request lands here. Public so Apache or nginx can point at it, which is
 * what makes the app servable from a folder inside XAMPP.
 */
/*
 * The autoloader.
 *
 * Checks this directory and its parent, because the backend is laid out
 * differently in the two places it runs. In a checkout the front controller
 * sits in public/ with vendor/ one level up; the XAMPP install flattens it so
 * the whole backend is one folder and vendor/ sits alongside index.php.
 *
 * Hardcoding either path breaks the other silently, and the symptom is a blank
 * page rather than an error, which is why both are tried here.
 */
$autoload = is_file(__DIR__ . '/vendor/autoload.php')
    ? __DIR__ . '/vendor/autoload.php'
    : __DIR__ . '/../vendor/autoload.php';

if (!is_file($autoload)) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    // Named explicitly, because "the app is broken" with no hint costs more time
    // than it saves.
    echo json_encode([
        'error' => 'Composer dependencies are missing.',
        'detail' => 'Run "composer install" in the backend-php folder.',
    ]);
    exit;
}

require_once $autoload;

/*
 * The backend root: the folder holding vendor/, app/ and routes/.
 *
 * realpath() matters here. Without it the candidate path keeps the '/../' from
 * the autoloader search, so dirname() on it returns 'public' rather than the
 * folder above - and every path derived from $base then points somewhere that
 * does not exist. The failure is silent: the app boots, finds no .env, and
 * reports a missing JWT_SECRET rather than a bad path.
 *
 * Stripping the '/vendor/autoload.php' suffix rather than calling dirname(),
 * which would leave 'vendor' itself and then look for vendor/app.
 */
$base = realpath(substr($autoload, 0, -strlen('/vendor/autoload.php'))) ?: __DIR__;

use TheTeam\ApiRoutes;
use TheTeam\Database;
use TheTeam\Env;
use TheTeam\Log;
use TheTeam\RateLimit;
use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Router;

/*
 * Which .env to read.
 *
 * The .env beside this file always wins. When running from a checkout that is
 * backend-php/.env; in a XAMPP install it is the one the deploy script wrote into
 * backend/, and that one is the only one present.
 *
 * A parent .env is read as a fallback so a checkout can pick up backend/.env,
 * the file the Node app uses. Sharing one file between the two is deliberate: a
 * duplicated config is the most reliable way to run them against different
 * databases, and that surfaces much later as missing data or a login that
 * mysteriously fails. Sharing also means rotating JWT_SECRET signs out both,
 * which is what you want - a token from one must not silently keep working on
 * the other after a rotation.
 */
$ownEnv = $base;

// Before anything logs, so the startup banner reaches the terminal when there
// is one. Under Apache there is no terminal, and it goes to the error log.
Log::useStderr(PHP_SAPI === 'cli' || PHP_SAPI === 'cli-server');

// Closest first, so a port-specific file always wins over the shared one.
// $ownEnv is the folder holding vendor/.
Env::load($ownEnv);

/*
 * Then the checkout layout: the project root is one level above the backend
 * folder, and backend/.env - the file the Node app uses - sits inside it.
 *
 * $base is the folder holding vendor/, which is backend-php/ in a checkout but
 * backend/ in a XAMPP install. Going up from it rather than from __DIR__ means
 * the same line is correct in both, and in an install it simply points at a
 * directory with no .env in it.
 */
Env::load(dirname($ownEnv) . '/backend');

Env::finish();

/*
 * Error handling.
 *
 * Installed before anything else so that no PHP error can ever reach the client
 * as HTML. The frontend parses every response as JSON, and a fatal printed into
 * the body turns a real bug into an unhelpful "Unexpected token < in JSON" in the
 * browser console with the actual cause nowhere on screen.
 *
 * Development shows the detail because that is the only useful thing it can do;
 * production shows a generic message and keeps the detail in the log, since the
 * stack trace names files, line numbers and table names.
 */
$isProduction = Env::get('NODE_ENV', 'development') === 'production';

/*
 * Stop PHP writing its own error text into the response body.
 *
 * The handler below logs warnings and returns true, which tells PHP the warning
 * was handled - but only if display_errors is off. With it on, a warning is
 * still printed, and it arrives in the middle of the JSON the frontend is
 * trying to parse. The result is a parse error pointing at a `<br />` tag
 * thousands of characters from the real cause.
 *
 * This is set before anything can emit a warning, so it is in force for the
 * rest of the request. @ is deliberately not used instead: it suppresses the
 * warning from the log as well, which is where the evidence of the bug would be.
 */
@ini_set('display_errors', '0');
@ini_set('display_startup_errors', '0');
// Log them anyway - suppressing them from the user is the point, not losing them.
@ini_set('log_errors', '1');

set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if ((error_reporting() & $severity) === 0) {
        return false; // suppressed on purpose somewhere; respect that
    }

    Log::warn(sprintf('%s in %s:%d', $message, $file, $line));
    return true; // handled: nothing is echoed to the response
});

/*
 * \Throwable is fully qualified on purpose. This file is in the global namespace
 * but the handler is a closure that inherits the TheTeam namespace from the use
 * statements above, so a bare Throwable resolves to TheTeam\Throwable and the
 * handler itself fatals when it is called with any exception - which is exactly
 * when it is needed.
 */
set_exception_handler(static function (\Throwable $e) use ($isProduction): void {
    Log::warn('unhandled ' . get_class($e) . ': ' . $e->getMessage()
        . ' at ' . $e->getFile() . ':' . $e->getLine());

    if (headers_sent()) {
        return; // too late to say anything useful
    }

    Response::json(
        $isProduction
            ? ['error' => 'Something went wrong on the server.']
            : [
                'error' => 'Something went wrong on the server.',
                'detail' => $e->getMessage(),
                'where' => $e->getFile() . ':' . $e->getLine(),
            ],
        500
    );
});

// CORS, matching the cors({...}) setup in the Node server. Only needed when the
// frontend is served from a different origin during development; in production
// both come from the same server and this does nothing.
$allowedOrigin = Env::get('CORS_ORIGIN', 'http://localhost:4173');
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && ($origin === $allowedOrigin || Env::get('NODE_ENV') !== 'production')) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Credentials: true');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
}

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// The helmet equivalent, one by one. Kept explicit so each header's purpose is
// visible rather than inherited from a library's defaults.
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('X-XSS-Protection: 0'); // deprecated, and misleading when it is present

$request = new Request();
$path = $request->path();
$method = $request->method();

/*
 * Sub-path support, matching the APP_BASE_PATH rewrite in the Node server.
 *
 * Apache can either strip the prefix before proxying or pass it through, and
 * which one happens depends on the RewriteRule in the vhost file. Stripping it
 * here as well makes both work, and leaves the routes registered once.
 */
$basePath = rtrim(Env::get('APP_BASE_PATH', '') ?? '', '/');
if ($basePath !== '' && ($path === $basePath || str_starts_with($path, $basePath . '/'))) {
    $path = substr($path, strlen($basePath)) ?: '/';
}

/*
 * Rate limiting.
 *
 * express-rate-limit keeps its counters in memory, per process. The same is done
 * here with APCu where available and a file otherwise; the exact mechanism does
 * not matter, only that login and password reset stay limited, because those are
 * the endpoints worth guessing at.
 *
 * $base is resolved the same way as the autoloader, because this file is loaded
 * directly rather than through the autoloader and cannot rely on it.
 */
require_once $base . '/app/RateLimit.php';
RateLimit::init(sys_get_temp_dir());

$router = new Router();

/*
 * Health, registered before the API groups so it answers even when one of them
 * fails to load. A health check that dies with the thing it is checking gives no
 * warning at all.
 */
$router->get('/api/health', function () {
    Response::json([
        'status' => 'ok',
        'message' => 'THE TEAM API is running (php)',
        'version' => Env::get('APP_VERSION', '1.0.0'),
        'build' => Env::get('BUILD_ID', 'php'),
        'timestamp' => gmdate('c'),
        'port' => [
            // Reports what the PHP port covers so far, rather than leaving a
            // half-finished port indistinguishable from a complete one.
            'mounted' => ApiRoutes::mountedGroups(),
            'pending' => ApiRoutes::pendingGroups(),
        ],
    ]);
});

/*
 * The route files return a registration closure rather than executing on
 * include, so each one is called here. A bare `require` would load them and
 * quietly register nothing - and every endpoint would 404 while /api/health,
 * registered above, kept answering "ok".
 */
$registerApi = require $base . '/routes/api.php';
$registerApi($router);

$registerWeb = require $base . '/routes/web.php';
$registerWeb($router);

$router->dispatch($method, $path);