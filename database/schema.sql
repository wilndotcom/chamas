-- ============================================
-- THE TEAM - Chama Management System
-- Database Schema for MySQL (XAMPP)
-- ============================================

CREATE DATABASE IF NOT EXISTS the_team_chama;
USE the_team_chama;

-- ============================================
-- ROLES & PERMISSIONS
-- ============================================

CREATE TABLE roles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE permissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE role_permissions (
    role_id INT NOT NULL,
    permission_id INT NOT NULL,
    PRIMARY KEY (role_id, permission_id),
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

-- ============================================
-- ADMINS
-- ============================================

CREATE TABLE admins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    -- Sign in with either the email or the username. Nullable so existing
    -- installs keep working after the upgrade; UNIQUE so set values cannot clash.
    username VARCHAR(100) NULL UNIQUE,
    email VARCHAR(100) UNIQUE NOT NULL,
    phone VARCHAR(20),
    password_hash VARCHAR(255) NOT NULL,
    role_id INT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    last_login TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES roles(id)
);

-- ============================================
-- MEMBERS
-- ============================================

CREATE TABLE members (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE,
    phone VARCHAR(20) UNIQUE NOT NULL,
    id_number VARCHAR(50),
    password_hash VARCHAR(255) NOT NULL,
    status ENUM('active', 'inactive', 'suspended') DEFAULT 'active',
    emergency_contact_name VARCHAR(100),
    emergency_contact_phone VARCHAR(20),
    joined_date DATE NOT NULL,
    last_login TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ============================================
-- CONTRIBUTIONS
-- ============================================

CREATE TABLE contributions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    member_id INT NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    contribution_date DATE NOT NULL,
    payment_method ENUM('mpesa_stk', 'mpesa_c2b', 'airtel_money', 'cash', 'bank') DEFAULT 'mpesa_stk',
    reference_number VARCHAR(100),
    status ENUM('pending', 'confirmed', 'failed') DEFAULT 'pending',
    remarks TEXT,
    recorded_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id) REFERENCES members(id),
    FOREIGN KEY (recorded_by) REFERENCES admins(id)
);

-- ============================================
-- LOANS
-- ============================================

CREATE TABLE loans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    member_id INT NOT NULL,
    principal_amount DECIMAL(12,2) NOT NULL,
    interest_rate DECIMAL(5,2) NOT NULL,
    interest_amount DECIMAL(12,2) NOT NULL,
    total_repayable DECIMAL(12,2) NOT NULL,
    amount_paid DECIMAL(12,2) DEFAULT 0.00,
    balance DECIMAL(12,2) NOT NULL,
    status ENUM('pending', 'approved', 'disbursed', 'active', 'completed', 'defaulted', 'rejected') DEFAULT 'pending',
    purpose TEXT,
    application_date DATE NOT NULL,
    approval_date DATE NULL,
    disbursement_date DATE NULL,
    due_date DATE NULL,
    approved_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id) REFERENCES members(id),
    FOREIGN KEY (approved_by) REFERENCES admins(id)
);

-- ============================================
-- LOAN REPAYMENTS
-- ============================================

CREATE TABLE loan_repayments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    loan_id INT NOT NULL,
    member_id INT NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    payment_date DATE NOT NULL,
    payment_method ENUM('mpesa_stk', 'mpesa_c2b', 'airtel_money', 'cash', 'bank') DEFAULT 'mpesa_stk',
    reference_number VARCHAR(100),
    remarks TEXT,
    recorded_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (loan_id) REFERENCES loans(id),
    FOREIGN KEY (member_id) REFERENCES members(id),
    FOREIGN KEY (recorded_by) REFERENCES admins(id)
);

-- ============================================
-- WELFARE / HARDSSHIP FUND
-- ============================================

CREATE TABLE welfare_contributions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    member_id INT NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    contribution_date DATE NOT NULL,
    payment_method ENUM('mpesa_stk', 'mpesa_c2b', 'airtel_money', 'cash', 'bank') DEFAULT 'mpesa_stk',
    reference_number VARCHAR(100),
    status ENUM('pending', 'confirmed', 'failed') DEFAULT 'pending',
    remarks TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id) REFERENCES members(id)
);

CREATE TABLE welfare_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    member_id INT NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    reason TEXT NOT NULL,
    status ENUM('pending', 'approved', 'rejected', 'disbursed') DEFAULT 'pending',
    request_date DATE NOT NULL,
    approved_by INT NULL,
    approval_date DATE NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id) REFERENCES members(id),
    FOREIGN KEY (approved_by) REFERENCES admins(id)
);

-- ============================================
-- EXPENSES
-- Chama income is interest on loans. To show a real profit figure we must
-- also track what the chama spends: stationery, transport, bank charges,
-- meeting costs, and any loan written off as a loss.
-- ============================================

CREATE TABLE expenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    category VARCHAR(100) NOT NULL,
    description TEXT,
    amount DECIMAL(12,2) NOT NULL,
    expense_date DATE NOT NULL,
    payment_method ENUM('mpesa_stk', 'mpesa_c2b', 'airtel_money', 'cash', 'bank') DEFAULT 'cash',
    reference_number VARCHAR(100),
    recorded_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recorded_by) REFERENCES admins(id),
    INDEX idx_expense_date (expense_date)
);

-- ============================================
-- NOTIFICATIONS
-- ============================================

CREATE TABLE notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    member_id INT,
    admin_id INT,
    type ENUM('sms', 'whatsapp', 'email', 'in_app') NOT NULL,
    category ENUM('payment', 'loan', 'welfare', 'general', 'reminder') NOT NULL,
    subject VARCHAR(255),
    message TEXT NOT NULL,
    status ENUM('pending', 'sent', 'failed') DEFAULT 'pending',
    sent_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id) REFERENCES members(id),
    FOREIGN KEY (admin_id) REFERENCES admins(id)
);

-- ============================================
-- SYSTEM SETTINGS
-- ============================================

CREATE TABLE settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    setting_key VARCHAR(100) UNIQUE NOT NULL,
    setting_value TEXT,
    description TEXT,
    updated_by INT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (updated_by) REFERENCES admins(id)
);

-- ============================================
-- AUDIT LOGS
-- ============================================

CREATE TABLE audit_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    admin_id INT,
    member_id INT,
    action VARCHAR(255) NOT NULL,
    details JSON,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES admins(id),
    FOREIGN KEY (member_id) REFERENCES members(id)
);

-- ============================================
-- M-PESA TRANSACTIONS LOG
-- ============================================

CREATE TABLE mpesa_transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    transaction_id VARCHAR(100) UNIQUE,
    phone VARCHAR(20) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    reference VARCHAR(255),
    type ENUM('stk_push', 'c2b', 'b2c') NOT NULL,
    status ENUM('pending', 'success', 'failed') DEFAULT 'pending',
    response_data JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- ============================================
-- PAYMENT GATEWAYS
-- ============================================
-- The catalogue of accepted payment methods, so they can be switched on or off
-- in one place rather than hardcoded into every payment form.
--
-- Credentials are NOT stored here. M-Pesa keeps its keys in `settings`; this
-- table only records which gateways exist and whether each is accepted.
--
-- Switching one off hides it from every payment method list. Historical rows in
-- contributions, loan_repayments and mpesa_transactions keep the method they
-- were written with.

CREATE TABLE IF NOT EXISTS payment_gateways (
    id INT AUTO_INCREMENT PRIMARY KEY,
    gateway_key VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    description VARCHAR(255) NULL,
    is_enabled TINYINT(1) NOT NULL DEFAULT 1,
    requires_config TINYINT(1) NOT NULL DEFAULT 0,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- INSERT IGNORE, so re-running this file never re-enables a gateway an operator
-- switched off.
-- One row per gateway, matching migration 012. M-Pesa is split because STK Push
-- and the paybill are chosen separately: one needs the Daraja STK endpoint
-- registered, the other a callback URL. Airtel Money ships switched off since its
-- payment integration is not built yet.
INSERT IGNORE INTO payment_gateways
    (gateway_key, display_name, description, is_enabled, requires_config, sort_order)
VALUES
    ('mpesa_stk', 'M-Pesa STK Push',
     'The app prompts the phone of the member to pay. Needs the Daraja STK Push endpoint registered on your app.', 1, 1, 1),
    ('mpesa_c2b', 'M-Pesa (Paybill / Till)',
     'Safaricom posts a confirmation to this app when the member pays your paybill number.', 1, 1, 2),
    ('airtel_money', 'Airtel Money',
     'Airtel Money merchant checkout. Listed so you can plan for it; the payment call is not built yet.', 0, 1, 3),
    ('bank', 'Bank Transfer',
     'Record a transfer a member made directly into the chama account.', 1, 0, 4),
    ('cash', 'Cash',
     'Money handed over at the meeting. Recorded by an admin.', 1, 0, 5);
-- ============================================
-- CHAMA BRANDING
-- ============================================
-- The chama name lives in `settings` (see the seed below) and is already read by
-- the notification and reminder code. This table holds the logo only.
--
-- Logo bytes are stored rather than a file path so a deployment needs no
-- writable upload directory and no extra nginx rule.
-- MEDIUMTEXT is required: even a small PNG or JPEG exceeds TEXT's 64KB.

CREATE TABLE IF NOT EXISTS chama_profile (
    id INT AUTO_INCREMENT PRIMARY KEY,
    logo_data MEDIUMTEXT NULL,
    logo_mime VARCHAR(100) NULL,
    logo_filename VARCHAR(255) NULL,
    logo_updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- One brand row per installation.
INSERT IGNORE INTO chama_profile (id) VALUES (1);

-- ============================================
-- SEED DATA
-- ============================================

SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE role_permissions;
TRUNCATE TABLE permissions;
TRUNCATE TABLE roles;
SET FOREIGN_KEY_CHECKS = 1;

INSERT INTO roles (name, description) VALUES
('super_admin', 'Full system access'),
('treasurer', 'Manages finances and contributions'),
('chairperson', 'Oversees members and loan approvals'),
('secretary', 'Manages communication and records'),
('admin', 'General operations');

INSERT INTO permissions (name, description) VALUES
('manage_members', 'Add, edit, remove members'),
('view_members', 'View member profiles'),
('record_contributions', 'Record member contributions'),
('approve_loans', 'Approve and disburse loans'),
('view_loans', 'View loan records'),
('configure_rates', 'Configure interest rates and settings'),
('view_reports', 'View financial reports'),
('send_notifications', 'Send notifications to members'),
('manage_admins', 'Create and manage admin accounts'),
('view_audit_logs', 'View system audit logs'),
('system_settings', 'Manage system configuration'),
('export_data', 'Export data to Excel/PDF'),
('manage_welfare', 'Manage welfare fund');

-- Assign all permissions to super_admin
INSERT INTO role_permissions (role_id, permission_id)
SELECT 1, id FROM permissions;

-- Treasurer permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT 2, id FROM permissions WHERE name IN ('view_members', 'record_contributions', 'view_loans', 'view_reports', 'export_data');

-- Chairperson permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT 3, id FROM permissions WHERE name IN ('manage_members', 'view_members', 'approve_loans', 'view_loans', 'view_reports', 'send_notifications', 'manage_welfare');

-- Secretary permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT 4, id FROM permissions WHERE name IN ('view_members', 'send_notifications');

-- Admin permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT 5, id FROM permissions WHERE name IN ('manage_members', 'view_members', 'record_contributions', 'view_loans', 'manage_welfare');

-- Default settings
INSERT INTO settings (setting_key, setting_value, description) VALUES
('monthly_contribution', '1000', 'Default monthly contribution amount (KES)'),
('loan_interest_rate', '10', 'Default loan interest rate (%)'),
('loan_duration_months', '3', 'Default loan duration in months'),
('max_loan_multiplier', '3', 'Maximum loan as multiple of total contributions'),
('welfare_contribution', '500', 'Default welfare contribution (KES)'),
('chama_name', 'THE TEAM', 'Chama name'),
('mpesa_paybill', '000000', 'M-Pesa Paybill/Till number'),
('mpesa_consumer_key', '', 'M-Pesa Daraja Consumer Key'),
('mpesa_consumer_secret', '', 'M-Pesa Daraja Consumer Secret'),
('mpesa_shortcode', '', 'M-Pesa Shortcode'),
('mpesa_passkey', '', 'M-Pesa STK Push Passkey'),
('sms_api_key', '', 'Africa''s Talking or Twilio API Key'),
('email_from', '', 'Sender email address'),
('allow_impersonation', '1', 'Allow super admin to view portals as another member or admin'),
('savings_interest_rate', '5', 'Interest payable to members on their savings when exiting (%)'),
('reminder_day_of_month', '5', 'Day of month to send contribution reminders'),
('reminder_channels', 'sms', 'Comma separated default channels: sms,whatsapp,email');
