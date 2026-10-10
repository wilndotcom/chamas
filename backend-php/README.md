# THE TEAM — PHP port

The Express backend, ported to PHP so the app runs on shared hosting (XAMPP and
similar) with no Node runtime.

**The React frontend is unchanged.** It talks to the same API, so nothing in
`frontend/` had to be touched.

## Status

This is a port in progress, not a finished one. `GET /api/health` reports exactly
where it stands:

```json
{
  "status": "ok",
  "port": {
    "mounted": ["/api/auth"],
    "pending": ["/api/members", "/api/loans", "..."]
  }
}
```

Groups that are not ported yet answer **501** and name themselves, rather than
404ing. A 501 says "the work isn't done"; a 404 would look like a bug in working
code, and the two are impossible to tell apart from the frontend.

### Done

| Area | Notes |
| --- | --- |
| Bootstrap | `public/index.php`, env loading, CORS, security headers, error handling |
| Routing | Patterns with `:params` and `*` wildcards; method matching; SPA fallback |
| Database | PDO with real prepared statements; `all` / `one` / `scalar` / `insert` / `transaction` |
| Auth | Admin + member login, JWT issue and verify, permissions, super admin, impersonation |
| Rate limiting | Per-IP counters via APCu, falling back to locked files |

### Not yet

Members, contributions, loans, welfare, transparency, notifications, settings,
M-Pesa, reports, ledger, roles, permissions, chama, payment gateways.

**Do not deploy this yet.** The Node version at `../backend` is complete and
still works.

## Running it

```bash
composer install

# Development
php -S localhost:5050 -t public public/index.php
```

Then `node check.mjs` to verify it against the Node version's behaviour.

## Why it is safe to switch

The strongest risk in a backend swap is a cutover that logs everybody out. It
cannot happen here, and `check-interop.mjs` proves it on every run:

- Tokens are HS256 with the same claim shape as `jsonwebtoken` produced
- `JWT_SECRET` is read from the same `.env`, so both backends verify each other
- Passwords are bcrypt both sides, so nobody has to reset anything
- `JWT_EXPIRES_IN` parses identically

Each of those is checked by asserting across both live servers, so a change that
breaks interop fails a test rather than logging out every user at once.

## Configuration

It reads `backend/.env` — the file the Node app already uses — rather than a
second copy. A duplicated config is the most reliable way to run the two ports
against different databases, and that surfaces much later as missing data or a
login that mysteriously fails.

A `backend-php/.env` is read as well, and takes precedence, for running against
a different database without touching the Node app.

To serve from a subfolder (XAMPP, alongside another app):

```env
APP_BASE_PATH=/the-team
```

## Two traps this port hit

**Backticks are not string delimiters in PHP.** They are shell execution.
A query written as `` `SELECT ...` `` runs a command that does not exist and
evaluates to `null`, so the query arrives empty and the error appears far from
the cause. Use heredoc. `Database::assertQuery()` rejects an empty query with a
message naming this, because every occurrence of this bug so far has been a
backtick.

**`STDERR` only exists on the CLI.** Under Apache it is an undefined constant, so
a diagnostic becomes a fatal error — and a fatal error printed into the response
turns into a JSON parse error in the browser with the real cause nowhere on
screen. Use `Log::warn()`.

## Tests

| File | Checks |
| --- | --- |
| `check.mjs` | Login, tokens, error strings, routing, body parsing |
| `check-interop.mjs` | Tokens crossing both ways; signature, expiry, lifetime |
| `check-token-types.mjs` | A real member token refused on admin routes |

Error strings are asserted exactly. The frontend branches on them, so a reworded
"helpful" message in PHP would break the portal with no obvious cause.