-- ============================================
-- THE TEAM — Migration 001
-- Adds expense tracking and the settings needed for
-- growth / interest / profit reporting and reminders.
--
-- Safe to run more than once.
-- ============================================

USE the_team_chama;

-- Expenses: required to report a real profit figure
CREATE TABLE IF NOT EXISTS expenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    category VARCHAR(100) NOT NULL,
    description TEXT,
    amount DECIMAL(12,2) NOT NULL,
    expense_date DATE NOT NULL,
    payment_method ENUM('mpesa_stk', 'mpesa_c2b', 'cash', 'bank') DEFAULT 'cash',
    reference_number VARCHAR(100),
    recorded_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recorded_by) REFERENCES admins(id),
    INDEX idx_expense_date (expense_date)
);

-- Reminder / reporting settings
INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
('savings_interest_rate', '5', 'Interest payable to members on their savings when exiting (%)'),
('reminder_day_of_month', '5', 'Day of month to send contribution reminders'),
('reminder_channels', 'sms', 'Comma separated default channels: sms,whatsapp,email');

-- Indexes that make the dashboard queries fast on larger chama
CREATE INDEX IF NOT EXISTS idx_contrib_date ON contributions (contribution_date);
CREATE INDEX IF NOT EXISTS idx_contrib_member ON contributions (member_id);
CREATE INDEX IF NOT EXISTS idx_loans_status ON loans (status);
CREATE INDEX IF NOT EXISTS idx_repayments_date ON loan_repayments (payment_date);