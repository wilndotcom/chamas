-- ============================================
-- THE TEAM — Migration 013
-- M-Pesa environment selectable in Settings.
-- ============================================
-- Until now the sandbox/production choice came only from MPESA_ENV in the
-- environment file, so changing it meant editing a file on the server and
-- restarting it. That is the one M-Pesa decision an operator makes repeatedly -
-- moving from sandbox testing to taking real money - and it was the only one they
-- could not make from the app.
--
-- Mirrors airtel_environment, which already works this way.
--
-- Defaults to sandbox deliberately: an existing install that had MPESA_ENV
-- unset is already behaving as sandbox today, so this preserves current
-- behaviour rather than silently switching anyone to live.
--
-- Resolution order matches every other M-Pesa value (settings, then environment),
-- so MPESA_ENV still wins on deployments that never open the Settings screen and
-- an operator can still override from the file if they prefer.

USE the_team_chama;

INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
  ('mpesa_environment', 'sandbox',
   'M-Pesa API: sandbox or production. Falls back to MPESA_ENV in the environment.');