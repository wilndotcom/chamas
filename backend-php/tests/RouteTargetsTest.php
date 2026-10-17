<?php

declare(strict_types=1);

/**
 * Every route resolves to a method that exists.
 *
 * Run: php backend-php/tests/RouteTargetsTest.php
 *
 * Written after a route spent the whole port pointing at
 * AuthController::memberRegister(), a method that was never written. It was
 * invisible to every other check: the route existed, /api/health reported the
 * group as mounted, and the only symptom was an HTML error page where the
 * registration form expected JSON - which reads as a frontend bug and sends the
 * search to the wrong half of the project.
 *
 * The Node version cannot have this fault. Express throws at registration when
 * a handler is undefined, so the server refuses to start and the mistake is
 * loud. PHP resolves a static call at the moment it is made, so a route wired
 * to nothing boots cleanly, answers the health check, and fails only when a
 * person uses that one screen.
 *
 * So this walks the real route table, reads the source of each handler, and
 * checks that what the handler calls is there - public, static, and reachable.
 */

require __DIR__ . '/../vendor/autoload.php';

use TheTeam\ApiRoutes;
use TheTeam\Router;

$pass = 0;
$fail = 0;
$problems = [];

function check(string $name, bool $ok, string $detail = ''): void
{
    global $pass, $fail, $problems;

    if ($ok) {
        $pass++;
        return;
    }

    $fail++;
    $problems[] = $name . ($detail !== '' ? ' - ' . $detail : '');
}

/**
 * Class names the route file imported, so a short name can be resolved the way
 * PHP would resolve it rather than by guessing at a namespace.
 *
 * @return array<string,string> alias => fully qualified name
 */
function importsIn(string $file): array
{
    $source = (string) file_get_contents($file);
    $imports = [];

    if (preg_match_all('/^\s*use\s+([A-Za-z0-9_\\\\]+)(?:\s+as\s+([A-Za-z0-9_]+))?\s*;/m', $source, $matches, PREG_SET_ORDER)) {
        foreach ($matches as $match) {
            $fqcn = ltrim($match[1], '\\');
            $alias = $match[2] ?? substr($fqcn, (int) strrpos($fqcn, '\\') + 1);
            $imports[$alias] = $fqcn;
        }
    }

    return $imports;
}

/**
 * Resolves a name used inside a route file to a real class.
 *
 * Tries what the file imported first, then the folders this project keeps its
 * classes in. Returns null only when none of them exist, which is itself the
 * failure being looked for.
 */
function resolveClass(string $name, array $imports): ?string
{
    if (isset($imports[$name])) {
        return $imports[$name];
    }

    if (str_contains($name, '\\')) {
        return class_exists($name) ? $name : null;
    }

    foreach (['TheTeam\\Controllers\\', 'TheTeam\\Utils\\', 'TheTeam\\'] as $prefix) {
        if (class_exists($prefix . $name)) {
            return $prefix . $name;
        }
    }

    return class_exists($name) ? $name : null;
}

// ---------------------------------------------------------------- the routes

$router = new Router();

$registerApi = require __DIR__ . '/../routes/api.php';
$registerApi($router);

$registerWeb = require __DIR__ . '/../routes/web.php';
$registerWeb($router);

// The route table is private, and reading it is the point: this checks what was
// actually registered, not what the files appear to say.
$property = new ReflectionProperty(Router::class, 'routes');
$property->setAccessible(true);
/** @var array<int, array{method:string, pattern:string, handler:callable}> $routes */
$routes = $property->getValue($router);

echo "  Checking " . count($routes) . " registered routes\n\n";

$checkedCalls = 0;
$importsByFile = [];

foreach ($routes as $route) {
    $label = $route['method'] . ' ' . $route['pattern'];
    $handler = $route['handler'];

    if (!is_object($handler) || !($handler instanceof Closure)) {
        // A handler that is not a closure cannot be read this way. Nothing in
        // the route table does this, so it is worth knowing about.
        check($label, false, 'handler is not a closure, so its target cannot be checked');
        continue;
    }

    $function = new ReflectionFunction($handler);
    $file = (string) $function->getFileName();
    $start = (int) $function->getStartLine();
    $end = (int) $function->getEndLine();

    if ($file === '' || $start === 0) {
        continue; // internally defined, nothing to read
    }

    $imports = $importsByFile[$file] ??= importsIn($file);

    $lines = file($file);
    $body = implode('', array_slice($lines ?: [], $start - 1, $end - $start + 1));

    // Class::method( - what the handler actually reaches for.
    if (!preg_match_all('/(?:\\\\?([A-Za-z_][A-Za-z0-9_]*)\\\\)*([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)\s*\(/', $body, $calls, PREG_SET_ORDER)) {
        continue; // an inline handler that does its own work
    }

    foreach ($calls as $call) {
        $class = $call[2];
        $method = $call[3];

        // self:: and static:: are inside the closure's own scope, which the
        // route files do not use; parent:: cannot appear in a closure either.
        if (in_array(strtolower($class), ['self', 'static', 'parent'], true)) {
            continue;
        }

        $checkedCalls++;

        $resolved = resolveClass($class, $imports);

        if ($resolved === null) {
            check($label, false, $class . ' is not a class this project has');
            continue;
        }

        if (!method_exists($resolved, $method)) {
            check($label, false, $resolved . '::' . $method . '() does not exist');
            continue;
        }

        $reflection = new ReflectionMethod($resolved, $method);

        if (!$reflection->isPublic()) {
            check($label, false, $resolved . '::' . $method . '() is not public');
            continue;
        }

        // The route table calls these statically. A non-static method called
        // that way is a fatal error in PHP 8, not a warning.
        if (!$reflection->isStatic()) {
            check($label, false, $resolved . '::' . $method . '() is not static, and is called statically');
            continue;
        }

        check($label . ' -> ' . $class . '::' . $method . '()', true);
    }
}

echo "  " . $checkedCalls . " handler calls resolved\n\n";

// ---------------------------------------------------------------- the port is complete

$pending = ApiRoutes::pendingGroups();

check(
    'no endpoint group is still waiting to be ported',
    $pending === [],
    $pending === [] ? '' : 'still pending: ' . implode(', ', $pending)
);

check(
    'the route table is not empty',
    count($routes) > 50,
    'only ' . count($routes) . ' routes registered, which cannot be the whole API'
);

// ---------------------------------------------------------------- result

if ($problems !== []) {
    echo "  Problems:\n";
    foreach ($problems as $problem) {
        echo "    " . $problem . "\n";
    }
    echo "\n";
}

echo "passed {$pass}, failed {$fail}\n";

exit($fail === 0 ? 0 : 1);
