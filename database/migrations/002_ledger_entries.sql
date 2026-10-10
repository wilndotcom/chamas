-- ============================================
-- THE TEAM — Migration 002
-- Cash book / ledger.
--
-- Contributions, repayments and expenses already produce cash movements, but a
-- chama also handles money that has no other home: interest collected in cash,
-- donations, fines, stationery bought outside the expenses form. ledger_entries
-- records those manually, and the cash book merges all sources into one ledger.
--
-- Safe to run more than once.
-- ============================================

USE the_team_chama;

CREATE TABLE IF NOT EXISTS ledger_entries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    direction ENUM('in', 'out') NOT NULL,
    category VARCHAR(100) NOT NULL,
    description TEXT,
    amount DECIMAL(12,2) NOT NULL,
    entry_date DATE NOT NULL,
    payment_method ENUM('mpesa_stk', 'mpesa_c2b', 'cash', 'bank') DEFAULT 'cash',
    reference_number VARCHAR(100),
    member_id INT NULL,
    recorded_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id) REFERENCES members(id),
    FOREIGN KEY (recorded_by) REFERENCES admins(id),
    INDEX idx_ledger_date (entry_date),
    INDEX idx_ledger_dir (direction)
);

CREATE INDEX IF NOT EXISTS idx_welfare_req_status ON welfare_requests (status);
CREATE INDEX IF NOT EXISTS idx_welfare_contrib_status ON welfare_contributions (status);
CREATE INDEX IF NOT EXISTS idx_loans_disbursed ON loans (disbursement_date);