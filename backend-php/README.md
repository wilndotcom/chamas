# THE TEAM — PHP port

The Express backend, ported to PHP so the app runs on shared hosting (XAMPP and
similar) with no Node runtime.

**The React frontend is unchanged.** It talks to the same API, so nothing in
`frontend/` had to be touched.

## Status

Complete. Every endpoint group the frontend calls is served by PHP. The Node
version at `../backend` is kept working as a fallback, reading the same database.

`GET /api/health` reports where it stands — `pending` is the list of groups not
ported yet, and it is empty:

```json
{
  "status": "ok",
  "port": { "mounted": ["/api/auth", "/api/members", "..."], "pending": [] }
}
```

A group that had not been ported answers **501** and names itself rather than
404ing. A 501 says "the work is not done"; a 404 looks like a bug in working code,
and the two are impossible to tell apart from the frontend.

### What is ported

| Area | Notes |
| --- | --- |
| Bootstrap | `public/index.php`, env loading, CORS, security headers, error handling |
| Routing | Patterns with `:params` and `*` wildcards; method matching; SPA fallback |
| Database | PDO with real prepared statements; `all` / `one` / `scalar` / `insert` / `transaction` |
| Auth | Admin + member login, JWT issue and verify, permissions, super admin, impersonation, first sign-in |
| Rate limiting | Per-IP counters via APCu, falling back to locked files |
| The rest | Members, contributions, loans, welfare, transparency, notifications, settings, M-Pesa, reports, ledger, roles, permissions, chama, payment gateways |

Error strings are asserted against the exact text the frontend branches on,
rather than being paraphrased.

## Running it

```bash
composer install

# Development
php -S localhost:5050 -t public public/index.php
```

Then `node check.mjs` to verify it.

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

Run against a PHP server on `:5050` (`PHP_BASE` overrides the address):

| File | Checks |
| --- | --- |
| `check.mjs` | Login, tokens, error strings, routing, body parsing |
| `check-settings.mjs` | The settings rules, especially the ones protecting credentials |
| `check-mpesa.mjs` | The M-Pesa callbacks |
| `check-member-payment.mjs` | A member's payment, end to end |
| `check-till.mjs` | That the M-Pesa settings are one till number |
| `check-first-login.mjs` | The first sign-in password rule, then puts the account back as it found it |
| `check-db-shapes.mjs` | That PDO returns values in the shape the port expects |
| `check-interop.mjs` | That the two backends accept each other's tokens |
| `check-parity.mjs` | PHP against Node, on the same live requests (needs Node on `:5000`) |
| `check-token-types.mjs` | A real member token refused on admin routes |
| `check-lifecycle.mjs` | The welfare fund and loans through their whole life cycle |

Plus the ones needing real credentials or a public address, which skip when those
are absent: `check-callback-arrives`, `check-pin-callback`, `check-till-live`,
`check-till-swap`, `check-till-works`, `check-learns-address`.

Error strings are asserted exactly. The frontend branches on them, so a reworded
"helpful" message in PHP would break the portal with no obvious cause.

`tests/reset-admin-passwords.php` is the one script here that changes the
database. It puts administrator accounts on the shared starting password and
requires a change at the next sign-in, or clears that requirement with
`--unblock`. Run the checks, then run it again without `--unblock` — the suites
sign in as that account and cannot do anything while it is flagged.