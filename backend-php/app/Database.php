<?php

declare(strict_types=1);

namespace TheTeam;

use PDO;
use PDOException;
use TheTeam\Log;

/**
 * The database handle.
 *
 * PDO with exceptions on and real prepared statements. The Node version used
 * mysql2 with execute(); the PHP equivalent that matters is that every value is
 * bound rather than interpolated, since these are money tables.
 */
final class Database
{
    private static ?PDO $pdo = null;

    public static function pdo(): PDO
    {
        if (self::$pdo instanceof PDO) {
            return self::$pdo;
        }

        $host = Env::get('DB_HOST', 'localhost');
        $name = Env::get('DB_NAME', 'the_team_chama');
        $user = Env::get('DB_USER', 'root');
        $pass = Env::get('DB_PASSWORD', '');

        $dsn = "mysql:host={$host};dbname={$name};charset=utf8mb4";

        try {
            self::$pdo = new PDO($dsn, $user, $pass, [
                // Real prepared statements, so bound values are never interpolated.
                PDO::ATTR_EMULATE_PREPARES => false,
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,

                /*
                 * Values come back as the strings MySQL holds.
                 *
                 * Without this, PDO builds DateTime objects in PHP's own timezone
                 * and json_encode renders them in UTC. A member who joined on the
                 * 4th is then shown the 3rd, because midnight in Nairobi is 21:00
                 * the previous day. The stored value is not in doubt - only the
                 * interpretation is wrong, and it happens in the browser.
                 *
                 * Done here rather than with a driver option because
                 * MYSQL_ATTR_FETCH_TABLE_DATETIME is not defined on every PHP
                 * build (this one does not have it) and naming an undefined
                 * constant is a fatal error, not a fallback. The rows are
                 * normalised in fetchAll() instead, which works everywhere.
                 */
                PDO::ATTR_STRINGIFY_FETCHES => true,
            ]);
        } catch (PDOException $e) {
            // The password is never echoed. An empty DB_PASSWORD plus a wrong
            // database name produces this, and printing the DSN leaks it.
            throw new \RuntimeException(
                'Database connection failed: ' . $e->getMessage() .
                ' (host ' . $host . ', database ' . $name . ')'
            );
        }

        self::applySessionTimezone(self::$pdo);

        return self::$pdo;
    }

    /**
     * Sets the connection's timezone.
     *
     * NOW() and CURDATE() are evaluated on the server using this, so a
     * contribution dated "today" is dated the same day for every user. Without
     * it the MySQL server's own zone decides, which on shared hosting is often
     * UTC - so a member entering a payment at 1am in Nairobi would have it
     * recorded against the previous day, and that day's total would be wrong.
     *
     * Tries the named zone first, then a fixed offset.
     *
     * The fallback matters more than it looks: MySQL only accepts named zones
     * when its timezone tables have been loaded, and many installs never load
     * them. A hard failure here would mean the app cannot start at all on a
     * perfectly ordinary server, over a setting that changes nothing about the
     * stored values - only about which day NOW() calls "today".
     *
     * Kenya has no daylight saving, so +03:00 is exact rather than an
     * approximation.
     */
    private static function applySessionTimezone(\PDO $pdo): void
    {
        $timezone = Env::getDatabaseTimezone();

        try {
            $pdo->exec('SET time_zone = ' . $pdo->quote($timezone));
            return;
        } catch (\Throwable $e) {
            // Fall through to the offset.
        }

        try {
            $pdo->exec('SET time_zone = ' . $pdo->quote(Env::get('DB_UTC_OFFSET', '+03:00')));
            Log::warn(sprintf(
                'MySQL does not know the timezone "%s" (its timezone tables are '
                . 'probably not loaded). Using the fixed offset %s instead. '
                . 'Both are correct for Kenya, which keeps no daylight saving.',
                $timezone,
                Env::get('DB_UTC_OFFSET', '+03:00')
            ));
        } catch (\Throwable $e) {
            Log::warn('could not set the database timezone at all: ' . $e->getMessage()
                . ' Dates recorded as "today" will use the server default.');
        }
    }

/**
     * Rejects a query that is empty before it reaches PDO.
     *
     * The reason this exists: in PHP a backtick is shell execution, not a string
     * delimiter. A query written as `SELECT ...` runs a command that does not
     * exist and evaluates to null, and null here surfaces as a confusing error
     * about argument types rather than "your SQL is missing". Every failure of
     * this kind so far has been a backtick, so the guard names that specifically.
     */
    private static function assertQuery(string $sql, string $where): void
    {
        if (trim($sql) === '') {
            throw new \InvalidArgumentException(
                'Empty SQL passed to Database::' . $where
                . '. If this query was written with backticks, remember that PHP'
                . ' runs a backtick as a shell command and yields null - use heredoc'
                . ' or quoted strings for SQL.'
            );
        }
    }

    /** Prepared statement. Named placeholders: :name rather than ?. */
    public static function run(string $sql, array $params = []): \PDOStatement
    {
        self::assertQuery($sql, 'run');
        $stmt = self::pdo()->prepare($sql);
        $stmt->execute($params);
        return $stmt;
    }

    /** All rows. */
    public static function all(string $sql, array $params = []): array
    {
        return array_map([self::class, 'normaliseRow'], self::run($sql, $params)->fetchAll());
    }

    /** One row, or null. */
    public static function one(string $sql, array $params = []): ?array
    {
        $row = self::run($sql, $params)->fetch();

        return $row === false ? null : self::normaliseRow($row);
    }

    /**
     * Prepares a row for JSON.
     *
     * Two conversions, both of which prevent a class of bug that a unit test
     * cannot see, because a hand-built fixture contains the types you expect
     * rather than the types the database produces.
     *
     * Dates: a DateTime becomes the string MySQL stored, with no timezone
     * applied. Applying one is what produces a join date a day out - midnight in
     * Nairobi is 21:00 the previous day in UTC - and the member's record is the
     * authority, not the server's locale.
     *
     * Money: DECIMAL columns arrive as strings, deliberately, so no precision is
     * lost on the way in. They are cast back to floats for the JSON response,
     * because a quoted number renders fine in a template and then concatenates
     * silently in any calculation - "0.00" + 100 is "0.00100", and nothing warns.
     *
     * The two decimal places are the application's own convention (see
     * Utils\LoanMath::round2) rather than a guess at the column's scale.
     */
    private static function normaliseRow(array $row): array
    {
        foreach ($row as $column => $value) {
            if ($value instanceof \DateTimeInterface) {
                $row[$column] = $value->format('Y-m-d H:i:s');
                continue;
            }

            if (self::isMoneyColumn($column) && is_string($value) && is_numeric($value)) {
                $row[$column] = (float) $value;
            }
        }

        return $row;
    }

    /**
     * Whether a column holds money.
     *
     * By name, because there is no reliable per-column type information in a PDO
     * result set - DECIMAL, BIGINT and VARCHAR all arrive as strings and cannot
     * be told apart here. Naming the columns is explicit, so adding a money
     * column to a query is a deliberate act rather than something that silently
     * keeps returning strings.
     *
     * `id` and the other primary keys are deliberately absent: they stay strings,
     * which is harmless, and casting them would only obscure a mismatch.
     */
    private static function isMoneyColumn(string $column): bool
    {
        return preg_match(
            '/(^|_)(amount|balance|total|paid|price|fee|interest|rate|principal|'
            . 'repayable|due|owe[ds]?)(_|$)/',
            $column
        ) === 1;
    }

    /** First column of the first row: the shape most COUNT and SUM queries want. */
    public static function scalar(string $sql, array $params = [])
    {
        $value = self::run($sql, $params)->fetchColumn();
        return $value === false ? null : $value;
    }

    public static function insert(string $sql, array $params = []): int
    {
        self::run($sql, $params);
        return (int) self::pdo()->lastInsertId();
    }

    /**
     * Runs a callable inside a transaction.
     *
     * Commits on return, rolls back on any throwable. The Node version used
     * getConnection()/begin/commit/rollback in welfareController and
     * mpesaController; this is the same guarantee without the try/finally noise
     * repeated at every call site.
     */
    public static function transaction(callable $work)
    {
        $pdo = self::pdo();
        $pdo->beginTransaction();
        try {
            $result = $work($pdo);
            $pdo->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /** Only used by the migration runner and tests. */
    public static function reset(): void
    {
        self::$pdo = null;
    }
}