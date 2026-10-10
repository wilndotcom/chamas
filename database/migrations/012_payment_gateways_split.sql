-- ============================================
-- THE TEAM — Migration 012
-- Payment gateways, one row per method.
-- ============================================
-- Previously a single 'mpesa' gateway covered both M-Pesa products, so they could
-- not be chosen separately and an operator could not enable a paybill without also
-- enabling STK Push. The brief is a list of gateways with one to choose from, so
-- each product is now its own entry and the choice is explicit.
--
--   mpesa_stk     STK Push. The app prompts the member's phone. Needs Daraja.
--   mpesa_c2b     Paybill. Safaricom posts a callback to the app. Needs Daraja.
--   airtel_money  Airtel Money merchant checkout.
--   bank          Manual record of a transfer.
--   cash          Money handed over at the meeting.
--
-- Both M-Pesa gateways read the same Daraja credentials (mpesa_* keys); they
-- differ only in the Daraja endpoint each needs registered, so configuration
-- status is reported per gateway rather than sharing one verdict.
--
-- Idempotent: safe to replay. The split inherits whatever state the operator had
-- set on the old combined row, so it never silently re-enables something they had
-- deliberately turned off.

USE the_team_chama;

-- ---------------------------------------------------------------------------
-- 1. payment_method gains airtel_money.
--
-- MODIFY is naturally idempotent: applying it twice produces the same enum. The
-- enum is shared by four tables, so all four are changed together to keep a value
-- valid everywhere it can be written.
-- ---------------------------------------------------------------------------
ALTER TABLE contributions
  MODIFY COLUMN payment_method
    ENUM('mpesa_stk','mpesa_c2b','airtel_money','cash','bank') DEFAULT 'mpesa_stk';

ALTER TABLE loan_repayments
  MODIFY COLUMN payment_method
    ENUM('mpesa_stk','mpesa_c2b','airtel_money','cash','bank') DEFAULT 'mpesa_stk';

ALTER TABLE welfare_contributions
  MODIFY COLUMN payment_method
    ENUM('mpesa_stk','mpesa_c2b','airtel_money','cash','bank') DEFAULT 'mpesa_stk';

ALTER TABLE expenses
  MODIFY COLUMN payment_method
    ENUM('mpesa_stk','mpesa_c2b','airtel_money','cash','bank') DEFAULT 'cash';

-- ledger_entries was added by migration 002 and carries its own copy of the enum,
-- so it is not covered by the four above. Missing it left a table that could not
-- record an Airtel Money payment even though every other one could.
ALTER TABLE ledger_entries
  MODIFY COLUMN payment_method
    ENUM('mpesa_stk','mpesa_c2b','airtel_money','cash','bank') DEFAULT 'mpesa_stk';

-- ---------------------------------------------------------------------------
-- 2. Split 'mpesa' into two gateways.
--
-- The children copy the parent's enabled state. A plain INSERT IGNORE would
-- default them to enabled and quietly undo a decision the operator had made.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO payment_gateways
    (gateway_key, display_name, description, is_enabled, requires_config, sort_order)
SELECT 'mpesa_stk',
       'M-Pesa STK Push',
       'The app prompts the member\'s phone to pay. Needs the Daraja STK Push endpoint registered.',
       is_enabled, 1, 1
FROM payment_gateways WHERE gateway_key = 'mpesa'
UNION ALL
SELECT 'mpesa_c2b',
       'M-Pesa (Paybill / Till)',
       'Safaricom posts a confirmation to the app when the member pays the paybill number.',
       is_enabled, 1, 2
FROM payment_gateways WHERE gateway_key = 'mpesa';

-- ---------------------------------------------------------------------------
-- 3. Remove the combined row.
--
-- Only after the children exist, and only if it is there, so the migration can
-- be replayed. Historical rows keep 'mpesa_stk' / 'mpesa_c2b' as their
-- payment_method, which are untouched by this change.
-- ---------------------------------------------------------------------------
DELETE FROM payment_gateways WHERE gateway_key = 'mpesa';

-- ---------------------------------------------------------------------------
-- 4. Airtel Money.
--
-- Disabled by default: selecting a gateway that cannot take money yet would put
-- a dead option in every member's payment dropdown.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO payment_gateways
    (gateway_key, display_name, description, is_enabled, requires_config, sort_order)
VALUES
    ('airtel_money', 'Airtel Money',
     'Airtel Money merchant checkout. Needs Airtel merchant credentials.',
     0, 1, 3);

-- ---------------------------------------------------------------------------
-- 5. Order the manual methods after the mobile-money ones.
-- ---------------------------------------------------------------------------
UPDATE payment_gateways SET sort_order = 4 WHERE gateway_key = 'bank';
UPDATE payment_gateways SET sort_order = 5 WHERE gateway_key = 'cash';

-- ---------------------------------------------------------------------------
-- 6. Airtel Money credentials.
--
-- Empty by default. The placeholder filter in mpesaConfig treats these as unset
-- until filled, so the gateway reports "needs setup" rather than pretending.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
  ('airtel_environment', 'sandbox', 'Airtel Money API: sandbox or production'),
  ('airtel_api_key', '', 'Airtel Money API key'),
  ('airtel_api_password', '', 'Airtel Money API password'),
  ('airtel_api_username', '', 'Airtel Money API username (Merchant Pay)'),
  ('airtel_merchant_id', '', 'Airtel Money merchant id'),
  ('airtel_service_provider_id', '', 'Airtel Money service provider id');