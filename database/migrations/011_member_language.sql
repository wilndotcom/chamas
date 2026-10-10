-- ============================================
-- THE TEAM — Migration 011
-- Per-user interface language.
-- ============================================
-- Settings already had a `language` key, but it is global: one admin choosing a
-- language forced it on every member, including people who cannot read it.
--
-- This adds a per-account preference for both portals. NULL means "use the
-- global setting in Settings", which keeps a fresh install behaving exactly as
-- before and gives admins a sensible default without anyone having to opt in.
--
-- Only codes that have real translations are accepted, and the API validates
-- against the same list, so a typo cannot leave someone with a blank picker.
-- These are the codes in frontend/src/i18n/dictionaries.js.
--
-- Both statements are guarded so the migration is safe to replay.

-- 1. members.language
SET @col_exists = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'members'
      AND COLUMN_NAME = 'language'
);
SET @add_col = IF(
    @col_exists > 0,
    'SELECT ''members.language already present'' AS note',
    'ALTER TABLE members ADD COLUMN language VARCHAR(10) NULL DEFAULT NULL AFTER status'
);
PREPARE s1 FROM @add_col;
EXECUTE s1;
DEALLOCATE PREPARE s1;

-- 2. admins.language
SET @col_exists = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'admins'
      AND COLUMN_NAME = 'language'
);
SET @add_col = IF(
    @col_exists > 0,
    'SELECT ''admins.language already present'' AS note',
    'ALTER TABLE admins ADD COLUMN language VARCHAR(10) NULL DEFAULT NULL AFTER is_active'
);
PREPARE s2 FROM @add_col;
EXECUTE s2;
DEALLOCATE PREPARE s2;

-- 3. Guard the value. MariaDB 10.2+ and MySQL 8.0.16+ both enforce CHECK, and
--    this server is MariaDB 10.4, so a code with no translation is rejected at
--    the database rather than silently falling back to English.
SET @chk_exists = (
    SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'members'
      AND CONSTRAINT_NAME = 'chk_members_language'
);
SET @add_chk = IF(
    @chk_exists > 0,
    'SELECT ''chk_members_language already present'' AS note',
    'ALTER TABLE members ADD CONSTRAINT chk_members_language CHECK (language IS NULL OR language IN (''en'', ''sw''))'
);
PREPARE s3 FROM @add_chk;
EXECUTE s3;
DEALLOCATE PREPARE s3;

SET @chk_exists = (
    SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'admins'
      AND CONSTRAINT_NAME = 'chk_admins_language'
);
SET @add_chk = IF(
    @chk_exists > 0,
    'SELECT ''chk_admins_language already present'' AS note',
    'ALTER TABLE admins ADD CONSTRAINT chk_admins_language CHECK (language IS NULL OR language IN (''en'', ''sw''))'
);
PREPARE s4 FROM @add_chk;
EXECUTE s4;
DEALLOCATE PREPARE s4;