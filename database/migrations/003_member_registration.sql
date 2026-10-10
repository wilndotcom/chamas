-- ============================================
-- THE TEAM — Migration 003
-- Member self-registration with admin approval.
--
-- Adds 'pending' and 'rejected' to the member status enum and stores why a
-- registration was turned down, so the applicant can be told.
--
-- Safe to run more than once.
-- ============================================

USE the_team_chama;

-- Widen the enum to cover the approval workflow
ALTER TABLE members
  MODIFY COLUMN status ENUM('pending', 'active', 'inactive', 'rejected', 'suspended')
    NOT NULL DEFAULT 'pending';

-- Why a registration was rejected
ALTER TABLE members
  ADD COLUMN rejection_reason VARCHAR(255) NULL AFTER status;

-- Who approved the registration, and when
ALTER TABLE members
  ADD COLUMN approved_by INT NULL AFTER rejection_reason,
  ADD COLUMN approved_at DATETIME NULL AFTER approved_by,
  ADD COLUMN reviewed_by INT NULL AFTER approved_at,
  ADD FOREIGN KEY (approved_by) REFERENCES admins(id) ON DELETE SET NULL,
  ADD FOREIGN KEY (reviewed_by) REFERENCES admins(id) ON DELETE SET NULL;

-- Registrations are queried by status on every admin dashboard load
CREATE INDEX IF NOT EXISTS idx_members_status ON members (status);