-- ============================================
-- THE TEAM - Migration 020
-- Audit rows name the record they are about.
-- ============================================
-- Why
-- ---
-- The audit writer has always recorded *which* record an action touched - the
-- administrator whose password was changed, the account that was impersonated -
-- as entity_type / entity_id, and both backends pass those two values whenever
-- the entry names a target. The columns were never added to the table.
--
-- The insert therefore fails with "Unknown column 'entity_type'", the caller
-- catches it on purpose (an audit failure must not block the action the operator
-- asked for), and the row is dropped. What that produces is worse than an empty
-- audit log: the log still lists the entries that do not name a target, so it
-- looks like it is working, while every entry that did name one is missing.
-- Changing a password is recorded only through this path, so on a running install
-- the one action an operator most wants a trail for has never been written.
--
-- Adding the columns makes the existing code work as it already reads. Nothing
-- else changes: the reader selects al.*, the member-history count joins on
-- member_id, and rows written before this migration keep their NULLs.
--
-- IF NOT EXISTS because the whole directory is replayed on every deploy.

USE the_team_chama;

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS entity_type VARCHAR(50) NULL AFTER action,
  ADD COLUMN IF NOT EXISTS entity_id INT NULL AFTER entity_type;
