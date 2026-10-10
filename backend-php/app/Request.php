<?php

declare(strict_types=1);

namespace TheTeam;

/**
 * The incoming request.
 *
 * Body and query parsing both produce an array, because a controller should not
 * care whether a value arrived in the URL or in the payload. That mirrors axios
 * sending JSON and Express parsing it into req.body.
 */
final class Request
{
    private ?array $body = null;

    /** @var array<string,string> Path parameters, set by the router. */
    public array $params = [];

    /** The signed-in principal, set by the auth middleware. */
    public ?array $user = null;

    public function method(): string
    {
        return strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    }

    public function path(): string
    {
        $uri = $_SERVER['REQUEST_URI'] ?? '/';
        $path = parse_url($uri, PHP_URL_PATH);
        return $path === false ? '/' : ($path ?: '/');
    }

    /** Header lookup, case-insensitive, as HTTP requires. */
    public function header(string $name): ?string
    {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        if (isset($_SERVER[$key])) {
            return $_SERVER[$key];
        }
        // CONTENT_TYPE and CONTENT_LENGTH arrive without the HTTP_ prefix.
        if ($name === 'Content-Type') {
            return $_SERVER['CONTENT_TYPE'] ?? null;
        }
        if ($name === 'Content-Length') {
            return $_SERVER['CONTENT_LENGTH'] ?? null;
        }
        return null;
    }

    public function bearerToken(): ?string
    {
        $auth = $this->header('Authorization') ?? '';
        if (!str_starts_with($auth, 'Bearer ')) {
            return null;
        }
        $token = trim(substr($auth, 7));
        return $token === '' ? null : $token;
    }

    /**
     * The decoded JSON body.
     *
     * Returns an empty array rather than null when there is no body, so callers
     * can index it without checking - and a malformed body is a 400 rather than
     * a silent empty array, because "your request had no fields" and "your
     * request was not JSON" are different problems.
     */
    public function body(): array
    {
        if ($this->body !== null) {
            return $this->body;
        }

        $raw = file_get_contents('php://input');
        if ($raw === false || trim($raw) === '') {
            $this->body = [];
            return $this->body;
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            Response::error('The request body was not valid JSON.', 400);
        }

        $this->body = $decoded;
        return $this->body;
    }

    public function input(string $key, $default = null)
    {
        $body = $this->body();
        if (array_key_exists($key, $body)) {
            return $body[$key];
        }
        return $_GET[$key] ?? $default;
    }

    public function query(string $key, $default = null)
    {
        return $_GET[$key] ?? $default;
    }

    public function param(string $key, $default = null): ?string
    {
        return $this->params[$key] ?? $default;
    }

    public function has(string $key): bool
    {
        return array_key_exists($key, $this->body());
    }

    /** Client address, for rate limiting. Proxy headers are not trusted by default. */
    public function ip(): string
    {
        return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    }
}