-- ============================================
-- THE TEAM - Migration 016
-- Admins are members, and welfare gets rules.
-- ============================================
-- Why
-- ---
-- Two gaps, both reported from real use:
--
-- 1. Admins were not members. There were 4 admins and 2 members with zero
--    overlap, so an admin could not save, contribute to welfare, borrow, or
--    appear in any member list. In a chama the chair and treasurer are also
--    ordinary savers, and the books were wrong about it.
--
--    Fix: admins keep their own login and permissions untouched, and each gains
--    a linked row in members. The link is admins.member_id, so the two records
--    can be told apart without guessing from an email or a name.
--
-- 2. Welfare had a single setting (the monthly amount) and no rules. Nothing
--    said whether welfare was on, how large a request could be, or who decided.
--    Those are decisions the group makes, so they belong in Settings.
--
-- Safe to run more than once.

USE the_team_chama;

-- ============================================
-- ADMINS -> MEMBERS LINK
-- ============================================

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS member_id INT NULL,
  ADD INDEX IF NOT EXISTS idx_admins_member (member_id);

-- Cannot add the foreign key in the same statement as the column on MySQL 5.7,
-- and the backfill below needs the column to exist first. Added separately and
-- guarded, because re-running must not fail on an existing constraint.
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admins'
    AND CONSTRAINT_NAME = 'fk_admins_member'
);
SET @fk_sql := IF(@fk_exists = 0,
  'ALTER TABLE admins ADD CONSTRAINT fk_admins_member
     FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL',
  'DO 0');
PREPARE stmt FROM @fk_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Backfill: one member row per admin that does not have one yet.
--
-- Three collisions have to be survived without aborting the migration, because
-- an admin's phone or email may already belong to a real member:
--
--   phone  NOT NULL and UNIQUE - a placeholder is generated when taken
--   email  nullable and UNIQUE - set to NULL when taken
--   password_hash NOT NULL  - the admin's own hash is reused, so the admin can
--                              also sign in to the member portal with the same
--                              credentials rather than being given a second one
--
-- admins.phone is itself nullable, so a placeholder is needed in that case too.
INSERT INTO members (full_name, email, phone, password_hash, status, joined_date)
SELECT
  a.full_name,
  -- Only claim the email if no member already holds it.
  CASE
    WHEN a.email IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM members m WHERE m.email = a.email)
    THEN a.email
    ELSE NULL
  END,
  -- Claim the phone if free; otherwise mint a distinct one. Starts with 9 so it
  -- can never be mistaken for a real Kenyan number in the member list.
  CASE
    WHEN a.phone IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM members m WHERE m.phone = a.phone)
    THEN a.phone
    ELSE CONCAT('9000000', LPAD(a.id, 4, '0'))
  END,
  a.password_hash,
  CASE WHEN a.is_active THEN 'active' ELSE 'inactive' END,
  DATE(a.created_at)
FROM admins a
WHERE a.member_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM members m WHERE m.phone = a.phone);

-- Link each admin to the member row just created for them. Matched on the phone
-- where it was claimed, and on the generated placeholder otherwise, so the link
-- is unambiguous rather than "the most recent member with a similar name".
UPDATE admins a
JOIN members m
  ON (a.phone IS NOT NULL AND m.phone = a.phone)
  OR (m.phone = CONCAT('9000000', LPAD(a.id, 4, '0')))
SET a.member_id = m.id
WHERE a.member_id IS NULL;

-- ============================================
-- WELFARE RULES
-- ============================================
-- Group decisions, so they are settings rather than constants in code.
-- Defaults describe the common case: welfare on, contributions recorded by an
-- admin, requests needing approval, no cap until the group sets one.

INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
  ('welfare_enabled', '1',
   'Welfare fund on or off. When off, no contributions are accepted and no requests are taken.'),
  ('welfare_contribution', '500',
   'The usual monthly welfare contribution per member.'),
  ('welfare_allow_self_contribution', '1',
   'Let members record their own welfare contribution instead of waiting for an admin.'),
  ('welfare_max_request_amount', '0',
   'Largest single welfare request allowed. 0 means no limit.'),
  ('welfare_min_months_contributed', '0',
   'Months a member must have contributed before they may request. 0 means no waiting period.'),
  ('welfare_request_needs_approval', '1',
   'When on, a request waits for an admin to approve it. When off, requests are approved on submission.');

-- The settings above are only editable if the allowlist knows about them.
-- Seeded here rather than patched into the controller so an install that upgrades
-- with an older controller still has the keys present, even if not yet editable.