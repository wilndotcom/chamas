<?php

declare(strict_types=1);

namespace TheTeam;

use PDO;
use PDOException;

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
            ]);
        } catch (PDOException $e) {
            // The password is never echoed. An empty DB_PASSWORD plus a wrong
            // database name produces this, and printing the DSN leaks it.
            throw new \RuntimeException(
                'Database connection failed: ' . $e->getMessage() .
                ' (host ' . $host . ', database ' . $name . ')'
            );
        }

        return self::$pdo;
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
        return self::run($sql, $params)->fetchAll();
    }

    /** One row, or null. */
    public static function one(string $sql, array $params = []): ?array
    {
        $row = self::run($sql, $params)->fetch();
        return $row === false ? null : $row;
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