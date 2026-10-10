-- ============================================
-- THE TEAM - Migration 018
-- Per-administrator two-factor lockout.
-- ============================================
-- Why
-- ---
-- The guess limit added in 017 counted attempts against a single code row. A
-- wrong guess that matched no row returned immediately, so an attacker trying
-- random six-digit codes never accumulated anything: every attempt was scored
-- against a code that did not exist, and the counter stayed at zero forever.
-- Six digits is a million possibilities, so an unlimited flow is not a limit.
--
-- The count belongs on the admin row, which is where a repeated guessing attempt
-- actually shows up, rather than on any one code.

USE the_team_chama;

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS two_factor_failures SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS two_factor_locked_until DATETIME NULL;