-- ============================================
-- THE TEAM — Migration 014
-- Notification channel credentials, editable in Settings.
-- ============================================
-- Why this exists
-- ---------------
-- The settings screen already offered an "SMS API key" field, and saving it
-- reported success. It then did nothing at all: utils/notifier.js read every
-- credential from process.env exclusively, so the key sat in the database while
-- the dispatcher kept using the values from the .env file. An operator could
-- type a working key, be told it was saved, and send no messages at all.
--
-- That is the same failure as the theme setting that could not be changed from
-- here: a control that looks functional and is not.
--
-- Everything below is empty by default. Resolution is settings first, then the
-- environment, so an existing deployment that never opens Settings keeps working
-- from its .env exactly as before.
--
-- Providers, matching what utils/notifier.js already knows how to call:
--   SMS       Africa's Talking, or Twilio   -> sms_provider picks between them
--   WhatsApp  Twilio                        -> requires Meta/Twilio approval
--   Email     SMTP                          -> nodemailer

USE the_team_chama;

INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
  -- Which provider to try first for each channel.
  ('sms_provider', 'africas_talking', 'SMS provider: africas_talking or twilio'),
  ('whatsapp_provider', 'twilio', 'WhatsApp provider: twilio'),

  -- Africa's Talking, used for SMS and optionally WhatsApp.
  ('sms_username', '', 'Africa''s Talking username'),
  ('sms_api_key', '', 'Africa''s Talking API key'),
  ('sms_sender_id', 'THE_TEAM', 'Africa''s Talking sender id or name'),

  -- Twilio, used for SMS and WhatsApp.
  ('twilio_account_sid', '', 'Twilio Account SID'),
  ('twilio_auth_token', '', 'Twilio Auth Token'),
  ('twilio_sms_from', '', 'Twilio SMS sender number'),
  ('twilio_whatsapp_number', '', 'Twilio WhatsApp sender, e.g. whatsapp:+14155238886'),

  -- SMTP.
  ('email_host', '', 'SMTP host, e.g. smtp.gmail.com'),
  ('email_port', '587', 'SMTP port'),
  ('email_user', '', 'SMTP username'),
  ('email_pass', '', 'SMTP password or app password'),
  ('email_from', '', 'Email sender address'),

  -- Whether each channel may be used at all. Separate from "configured": a
  -- channel can hold valid credentials and still be switched off, so an operator
  -- can stop sending SMS without deleting the keys.
  ('channel_sms_enabled', '1', 'Allow SMS notifications'),
  ('channel_whatsapp_enabled', '0', 'Allow WhatsApp notifications'),
  ('channel_email_enabled', '0', 'Allow email notifications');