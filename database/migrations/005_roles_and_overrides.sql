-- ============================================
-- THE TEAM — Migration 005
-- Custom roles and per-admin permission overrides.
--
-- role_permissions already lets a role carry a set of permissions. This adds
-- admin_permission_overrides so one admin inside a role can be granted or
-- denied something without creating a new role for them.
--
-- Safe to run more than once.
-- ============================================

USE the_team_chama;

CREATE TABLE IF NOT EXISTS admin_permission_overrides (
    admin_id INT NOT NULL,
    permission_id INT NOT NULL,
    mode ENUM('grant', 'revoke') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (admin_id, permission_id),
    FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

-- Marks roles that ship with the system and cannot be deleted.
ALTER TABLE roles
  ADD COLUMN is_system TINYINT(1) NOT NULL DEFAULT 0;

-- The five built-in roles are protected.
UPDATE roles SET is_system = 1 WHERE name IN
  ('super_admin', 'treasurer', 'chairperson', 'secretary', 'admin');

-- Namespaced groups so the permission matrix reads well in the UI.
ALTER TABLE permissions
  ADD COLUMN category VARCHAR(50) NOT NULL DEFAULT 'General' AFTER description;

UPDATE permissions SET category = 'Members'    WHERE name IN ('manage_members', 'view_members');
UPDATE permissions SET category = 'Contributions' WHERE name IN ('record_contributions');
UPDATE permissions SET category = 'Loans'      WHERE name IN ('approve_loans', 'view_loans');
UPDATE permissions SET category = 'Welfare'    WHERE name IN ('manage_welfare');
UPDATE permissions SET category = 'Reports'    WHERE name IN ('view_reports', 'export_data', 'configure_rates');
UPDATE permissions SET category = 'Communication' WHERE name IN ('send_notifications');
UPDATE permissions SET category = 'Administration' WHERE name IN ('manage_admins', 'view_audit_logs', 'system_settings');