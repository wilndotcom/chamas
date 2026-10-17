-- ============================================
-- THE TEAM - Migration 019
-- Administrator first sign-in password change.
-- ============================================
-- Why
-- ---
-- Administrator accounts are created with one shared, known password, so that
-- getting in for the first time does not require digging a generated string out
-- of backend/.env and typing it correctly. That convenience is only defensible
-- if it ends immediately: while this flag is set the account cannot be used for
-- anything except changing its own password.
--
-- The flag is what makes the difference between "a default password exists in the
-- published source" and "a default password is a working login on a running
-- chama", and this repository is public.
--
-- Set by the seed for administrators it creates, and by
-- backend-php/tests/reset-admin-passwords.php for existing accounts. Cleared by
-- PUT /api/auth/change-password, which is the only thing a flagged account may
-- do.

USE the_team_chama;

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS must_change_password TINYINT(1) NOT NULL DEFAULT 0 AFTER password_hash;

-- Existing accounts are left alone on purpose. Flagging them here would lock
-- every administrator out of a running install the moment this file is applied -
-- including installs whose administrators chose their own passwords long ago
-- and have nothing to change. Arming the flag is a deliberate act, taken by
-- whoever is doing the upgrade.
