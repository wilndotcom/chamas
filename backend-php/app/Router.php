<?php

declare(strict_types=1);

namespace TheTeam;

/**
 * Routing and the request.
 *
 * Deliberately small rather than a framework. The Express version declared
 * routes as app.use('/api/loans', loansRoutes); this does the same job with an
 * array of patterns, so a route table in the PHP port reads like the Node one
 * and can be compared against it line by line.
 *
 * Patterns use :name for a parameter and an asterisk for the tail, matching the
 * two shapes the routes actually use: /api/loans/:id/repay and /api/*.
 */
final class Router
{
    /** @var array<int, array{method:string, pattern:string, handler:callable}> */
    private array $routes = [];

    public function add(string $method, string $pattern, callable $handler): void
    {
        $this->routes[] = [
            'method' => strtoupper($method),
            'pattern' => $pattern,
            'handler' => $handler,
        ];
    }

    public function get(string $p, callable $h): void
    {
        $this->add('GET', $p, $h);
    }

    public function post(string $p, callable $h): void
    {
        $this->add('POST', $p, $h);
    }

    public function put(string $p, callable $h): void
    {
        $this->add('PUT', $p, $h);
    }

    /** PATCH, for partial updates. The member status endpoint uses it. */
    public function patch(string $p, callable $h): void
    {
        $this->add('PATCH', $p, $h);
    }

    public function delete(string $p, callable $h): void
    {
        $this->add('DELETE', $p, $h);
    }

    /**
     * Mounts a group of routes under a prefix.
     *
     * The equivalent of app.use('/api/loans', loansRoutes) in the Node version,
     * so each route file stays as small and as readable as it is there.
     */
    public function group(string $prefix, string $file): void
    {
        $register = require $file;
        $register($this, $prefix);
    }

    /** Finds a handler and calls it with any path parameters. */
    public function dispatch(string $method, string $path): void
    {
        $method = strtoupper($method);

        // A HEAD request is a GET without a body. Answering 405 for it breaks
        // health checks and uptime monitors.
        if ($method === 'HEAD') {
            $method = 'GET';
        }

        $pathMatchedWrongVerb = false;

        foreach ($this->routes as $route) {
            $params = self::match($route['pattern'], $path);
            if ($params === null) {
                continue;
            }

            if ($route['method'] !== $method) {
                // Only a specific route can prove a caller used the wrong verb.
                // A wildcard proves nothing: /* is registered for GET and would
                // otherwise turn every unmatched POST into a misleading 405 that
                // points at the real endpoint instead of at the missing route.
                if (!str_ends_with($route['pattern'], '*')) {
                    $pathMatchedWrongVerb = true;
                }
                continue;
            }

            $handler = $route['handler'];

            /*
             * The parameters are set on the request, not passed alongside it.
             *
             * A route declared as function (Request $r) receives nothing useful as
             * a second argument, so $r->param('id') silently returns null and every
             * id route 404s against rows that plainly exist. Setting them on the
             * request makes one shape of handler work for both simple and
             * parameterised routes, which is how the Node version's middleware
             * behaved - req.params came from Express, not from the callback
             * signature.
             */
            $request = new Request();
            $request->params = $params ?? [];

            $handler($request, $params ?? []);
            return;
        }

        if ($pathMatchedWrongVerb) {
            Response::error('Method not allowed.', 405);
        }

        Response::error('Route not found', 404);
    }

    /**
     * Matches a pattern to a path.
     *
     * @return array<string,string>|null Parameters, or null when it does not match
     */
    private static function match(string $pattern, string $path): ?array
    {
        // /api/* catches everything below that point, which is how the SPA
        // fallback and the pending-group placeholders are registered. Matched by
        // the route order, so real routes win.
        if (str_ends_with($pattern, '*')) {
            $prefix = rtrim(substr($pattern, 0, -1), '/');

            // /* with nothing in front of it. Normalised to '/', which still
            // matches only the root - not every path, which is what returning
            // empty parameters here used to do.
            if ($prefix === '') {
                return '/' === $path ? [] : null;
            }

            return str_starts_with($path, $prefix . '/') || $path === $prefix ? [] : null;
        }

        $patternParts = explode('/', trim($pattern, '/'));
        $pathParts = explode('/', trim($path, '/'));

        if (count($patternParts) !== count($pathParts)) {
            return null;
        }

        $params = [];
        foreach ($patternParts as $i => $part) {
            if (str_starts_with($part, ':')) {
                $params[substr($part, 1)] = $pathParts[$i];
                continue;
            }
            if ($part !== $pathParts[$i]) {
                return null;
            }
        }

        return $params;
    }
}