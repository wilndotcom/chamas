-- ============================================
-- THE TEAM - Migration 017
-- Filling the real gaps found in review.
-- ============================================
-- What and why
-- ------------
-- 1. Password reset. None existed, so a forgotten password needed an admin. That
--    is the most common support call any login has.
--
-- 2. Meeting register. A chama meets, and attendance is what stands behind
--    fines and contribution discipline. There was no record of it at all.
--
-- 3. Fines. Chamas discipline late or missed contributions by fining them. The
--    cash book had a "fine" label so one could be recorded by hand, but nothing
--    levied one or tracked it as owed.
--
-- 4. Shares and rotation. The defining mechanism of a ROSCA was entirely absent:
--    no table, no code. Members buy shares and receive them in turn.
--
-- 5. Loan repayment schedule. Only a single due_date existed, so arrears could
--    not be answered precisely. Instalments make "two months behind" a fact.
--
-- 6. Savings interest awards. The rate was displayed on a report and never paid,
--    which is a promise the app made and did not keep.
--
-- 7. Two-factor codes. The super admin can see everything and change roles.
--
-- 8. Duplicate detection guard on contributions, so the same amount from the same
--    member on the same day cannot be entered twice by accident.
--
-- Safe to run more than once.

USE the_team_chama;

-- ============================================
-- 1. PASSWORD RESET
-- ============================================
-- The token is stored hashed. A database dump must not hand over live reset
-- links, so the plaintext exists only in the email or SMS the user receives.
-- Expires in 30 minutes: long enough to use, short enough that a link found
-- months later is worthless.

CREATE TABLE IF NOT EXISTS password_resets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  principal_type ENUM('admin', 'member') NOT NULL,
  principal_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  -- Kept so the message can say which account was targeted without a second
  -- lookup, and so a resend can tell the user they already have one open.
  contact_hint VARCHAR(150),
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reset_token (token_hash),
  INDEX idx_reset_principal (principal_type, principal_id),
  INDEX idx_reset_expires (expires_at)
);

-- ============================================
-- 2. MEETINGS AND ATTENDANCE
-- ============================================

CREATE TABLE IF NOT EXISTS meetings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  meeting_date DATE NOT NULL,
  venue VARCHAR(150),
  -- Minutes taken, kept with the meeting because a chama's constitution ties
  -- decisions to its record.
  notes TEXT,
  recorded_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (recorded_by) REFERENCES admins(id) ON DELETE SET NULL,
  INDEX idx_meeting_date (meeting_date)
);

CREATE TABLE IF NOT EXISTS meeting_attendance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  meeting_id INT NOT NULL,
  member_id INT NOT NULL,
  -- Absent is recorded rather than omitted: knowing who was not there is the
  -- point of a register, so absence has to be a row.
  present TINYINT(1) NOT NULL DEFAULT 1,
  minutes_late SMALLINT NULL,
  note VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  -- One entry per member per meeting, so a double tap cannot double count.
  UNIQUE KEY uq_attendance (meeting_id, member_id),
  INDEX idx_attendance_member (member_id)
);

-- ============================================
-- 3. FINES
-- ============================================
-- Tracked as owed money rather than folded straight into the cash book, so a
-- member can see what they owe and why before it is paid.

CREATE TABLE IF NOT EXISTS fines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  member_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  levied_date DATE NOT NULL,
  status ENUM('pending', 'paid', 'waived', 'cancelled') NOT NULL DEFAULT 'pending',
  -- What triggered it, so "fine for missing the meeting" can be explained later.
  source_type ENUM('manual', 'missed_meeting', 'late_contribution') NOT NULL DEFAULT 'manual',
  source_id INT NULL,
  paid_date DATE NULL,
  waived_by INT NULL,
  waiver_reason VARCHAR(255),
  recorded_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id),
  FOREIGN KEY (recorded_by) REFERENCES admins(id) ON DELETE SET NULL,
  FOREIGN KEY (waived_by) REFERENCES admins(id) ON DELETE SET NULL,
  INDEX idx_fine_member (member_id, status),
  INDEX idx_fine_date (levied_date)
);

-- ============================================
-- 4. SHARES AND ROTATION
-- ============================================

CREATE TABLE IF NOT EXISTS shares (
  id INT AUTO_INCREMENT PRIMARY KEY,
  member_id INT NOT NULL,
  shares_count INT NOT NULL DEFAULT 0,
  price_per_share DECIMAL(12,2) NOT NULL DEFAULT 0,
  -- Cached total rather than a generated column, because MySQL versions here
  -- differ on generated-column support and this must run everywhere.
  total_value DECIMAL(12,2) NOT NULL DEFAULT 0,
  -- fully_paid while the member is still paying up; the count is what the
  -- rotation turns on.
  status ENUM('active', 'fully_paid', 'exited') NOT NULL DEFAULT 'active',
  acquired_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id),
  INDEX idx_share_member (member_id, status)
);

CREATE TABLE IF NOT EXISTS share_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  member_id INT NOT NULL,
  period_month CHAR(7) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  paid_date DATE NOT NULL,
  payment_method ENUM('mpesa_stk', 'mpesa_c2b', 'airtel_money', 'cash', 'bank') DEFAULT 'mpesa_stk',
  reference_number VARCHAR(100),
  status ENUM('confirmed', 'pending') NOT NULL DEFAULT 'confirmed',
  recorded_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id),
  FOREIGN KEY (recorded_by) REFERENCES admins(id) ON DELETE SET NULL,
  -- One payment per member per month, so a month cannot be paid twice by accident.
  UNIQUE KEY uq_share_payment (member_id, period_month),
  INDEX idx_share_period (period_month)
);

CREATE TABLE IF NOT EXISTS rotation_schedule (
  id INT AUTO_INCREMENT PRIMARY KEY,
  position_no INT NOT NULL,
  member_id INT NOT NULL,
  start_period CHAR(7) NOT NULL,
  -- Paused members keep their slot but stop counting, so a season abroad does
  -- not reshuffle everyone's turn.
  paused TINYINT(1) NOT NULL DEFAULT 0,
  note VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id),
  UNIQUE KEY uq_rotation_position (position_no),
  INDEX idx_rotation_member (member_id)
);

-- ============================================
-- 5. LOAN REPAYMENT SCHEDULE
-- ============================================
-- Instalments make arrears a fact rather than an estimate. amount_paid is
-- accumulated as repayments land, so a part-paid instalment is visible.

CREATE TABLE IF NOT EXISTS loan_instalments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  loan_id INT NOT NULL,
  instalment_no INT NOT NULL,
  due_date DATE NOT NULL,
  amount_due DECIMAL(12,2) NOT NULL,
  amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0,
  status ENUM('pending', 'partial', 'paid', 'overdue') NOT NULL DEFAULT 'pending',
  paid_date DATE NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE,
  UNIQUE KEY uq_instalment (loan_id, instalment_no),
  INDEX idx_instalment_due (due_date, status)
);

-- ============================================
-- 6. SAVINGS INTEREST AWARDS
-- ============================================
-- Interest that has been calculated and paid out, so a member can see it as a
-- receipt. Until this existed the rate was displayed on a report and never
-- reached anybody's balance.

CREATE TABLE IF NOT EXISTS savings_interest_awards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  member_id INT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  -- The balance the interest was calculated on, kept so the figure can be
  -- explained and audited later rather than merely trusted.
  principal DECIMAL(12,2) NOT NULL,
  rate_applied DECIMAL(6,2) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  paid_date DATE NOT NULL,
  status ENUM('paid', 'reversed') NOT NULL DEFAULT 'paid',
  recorded_by INT NULL,
  notes VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id),
  FOREIGN KEY (recorded_by) REFERENCES admins(id) ON DELETE SET NULL,
  INDEX idx_interest_member (member_id, period_end)
);

-- ============================================
-- 7. TWO-FACTOR LOGIN CODES
-- ============================================
-- A short numeric code delivered through the notification channels that
-- already exist, rather than a TOTP app. A chama treasurer on a phone in a
-- village is unlikely to have set up an authenticator, and a code that never
-- arrives locks them out of their own group.
--
-- The code is stored hashed for the same reason as the reset token.

CREATE TABLE IF NOT EXISTS two_factor_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admin_id INT NOT NULL,
  code_hash CHAR(64) NOT NULL,
  -- Ten minutes is long enough to find a phone and short enough that a code
  -- read over someone's shoulder is useless by the time it matters.
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  attempts SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
  INDEX idx_2fa_admin (admin_id, expires_at)
);

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS two_factor_enabled TINYINT(1) NOT NULL DEFAULT 0;

-- ============================================
-- 8. DUPLICATE CONTRIBUTION GUARD
-- ============================================
-- Nothing prevented the same amount from the same member on the same day being
-- entered twice. A key on (member, amount, date) alone would be too aggressive:
-- a member can legitimately contribute twice on one day. This is therefore a
-- warning surfaced in the API rather than a database constraint, so an admin
-- can still override it deliberately.

-- Settings for the guard, so the tolerance is a committee decision.
INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
  ('duplicate_contribution_guard', '1',
   'Warn when a contribution matches an existing one for the same member, amount and day.'),
  ('default_fine_amount', '0',
   'Fine charged for missing a meeting or paying late. 0 means the committee decides each time.'),
  ('shares_price_per_share', '0',
   'Price of one share. 0 until the group sets it.'),
  ('share_rotation_frequency', '1',
   'How often the turn comes round, in months. 1 is monthly.');