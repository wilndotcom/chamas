-- ============================================
-- PAYMENT GATEWAYS
-- ============================================
-- A registry of the ways members can pay, so they can be switched on or off in
-- one place instead of being hardcoded in every payment form.
--
-- Credentials live in `settings` (mpesa_* keys), not here. This table is the
-- catalogue: which gateways exist, their display names, and whether they are
-- currently accepted.
--
-- Switching a gateway off hides it from every payment method list. It does not
-- rewrite historical rows in contributions, loan_repayments or mpesa_transactions,
-- which keep the payment_method they were written with.
--
-- Idempotent: safe to replay during a deploy.

CREATE TABLE IF NOT EXISTS payment_gateways (
    id INT AUTO_INCREMENT PRIMARY KEY,
    -- Stable identifier used by the API and the frontend. Never localised.
    gateway_key VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    description VARCHAR(255) NULL,
    is_enabled TINYINT(1) NOT NULL DEFAULT 1,
    -- 1 when the gateway cannot work until its credentials are filled in.
    requires_config TINYINT(1) NOT NULL DEFAULT 0,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Seeded with the methods the app already supports. ON DUPLICATE KEY UPDATE is
-- avoided on is_enabled so that re-running this file never silently re-enables
-- a gateway an operator turned off.
INSERT IGNORE INTO payment_gateways
    (gateway_key, display_name, description, is_enabled, requires_config, sort_order)
VALUES
    ('mpesa', 'M-Pesa (Safaricom Daraja)',
     'STK Push and paybill (C2B) collections. Needs a Daraja app.', 1, 1, 1),
    ('bank', 'Bank Transfer',
     'Record a transfer a member made directly into the chama account.', 1, 0, 2),
    ('cash', 'Cash',
     'Money handed over at the meeting. Recorded by an admin.', 1, 0, 3);