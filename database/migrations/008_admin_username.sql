-- ============================================
-- ADMIN USERNAME (sign in with email OR username)
-- ============================================
-- An admin can now sign in with either their email or a short username.
--
-- Nullable on purpose: every existing admin already signs in with their email,
-- so nobody is locked out by the upgrade. Admins without a username keep using
-- their email until one is set.
--
-- MySQL treats NULLs as distinct in a UNIQUE index, so many admins may have
-- username NULL while set values still have to be unique.
--
-- Usernames are backfilled from the part of the email before the "@" by
-- seed.js, which is idempotent and already runs during deployment. Doing it
-- there rather than in SQL keeps it safe when two emails share a local part
-- (a@x.com and b@a.com both suggest "a").
--
-- Both statements are guarded so the migration is safe to replay.

-- 1. the column
SET @col_exists = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'admins'
      AND COLUMN_NAME = 'username'
);
SET @add_col = IF(
    @col_exists > 0,
    'SELECT ''admins.username already present'' AS note',
    'ALTER TABLE admins ADD COLUMN username VARCHAR(100) NULL DEFAULT NULL AFTER full_name'
);
PREPARE s1 FROM @add_col;
EXECUTE s1;
DEALLOCATE PREPARE s1;

-- 2. the unique index
SET @idx_exists = (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'admins'
      AND INDEX_NAME = 'uq_admins_username'
);
SET @add_idx = IF(
    @idx_exists > 0,
    'SELECT ''uq_admins_username already present'' AS note',
    'ALTER TABLE admins ADD UNIQUE KEY uq_admins_username (username)'
);
PREPARE s2 FROM @add_idx;
EXECUTE s2;
DEALLOCATE PREPARE s2;