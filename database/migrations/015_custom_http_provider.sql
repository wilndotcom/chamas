-- ============================================
-- THE TEAM — Migration 015
-- Custom HTTP delivery provider.
-- ============================================
-- Why
-- ---
-- The provider list in Settings is a fixed set written in code: Africa's Talking
-- and Twilio for SMS, Twilio for WhatsApp, SMTP for email. Anyone holding
-- credentials from a different vendor had nowhere to put them. That is a limit of
-- the design, not of the operator's setup.
--
-- This adds an escape hatch rather than another hardcoded vendor: point the app
-- at any endpoint that accepts an HTTP POST, choose how to authenticate, and
-- shape the request with placeholders. A vendor this app has never heard of then
-- works without a code change.
--
-- One set per channel, because the whole point is that SMS and WhatsApp can come
-- from different vendors.
--
-- Placeholders for the body template:
--   {{phone}}     recipient, in the format chosen below
--   {{message}}   the text to send
--   {{from}}      the sender id, where a {{from}} key exists at all
--
-- Phone format is asked for explicitly because the two conventions genuinely
-- disagree: this app normalises to 2547… with no plus for Daraja, while WhatsApp
-- APIs expect +2547…. Guessing silently sends to the wrong place.

USE the_team_chama;

-- Kept short deliberately. Three auth shapes cover almost everything in use:
-- a bearer token, an arbitrary header and value, or HTTP basic. "none" is there
-- for a local or already-network-protected endpoint.
INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
  ('custom_sms_endpoint', '', 'Custom SMS: full request URL'),
  ('custom_sms_method', 'POST', 'Custom SMS: HTTP method (POST or PUT)'),
  ('custom_sms_auth_type', 'none', 'Custom SMS: none, bearer, header or basic'),
  ('custom_sms_auth_header', '', 'Custom SMS: header name when auth_type is header'),
  ('custom_sms_auth_value', '', 'Custom SMS: token or header value'),
  ('custom_sms_username', '', 'Custom SMS: username for basic auth'),
  ('custom_sms_password', '', 'Custom SMS: password for basic auth'),
  ('custom_sms_body', '', 'Custom SMS: request body template, may use {{phone}} {{message}} {{from}}'),
  ('custom_sms_phone_format', '254', 'Custom SMS: phone format, 254 or +254'),
  ('custom_sms_sender', '', 'Custom SMS: value substituted for {{from}}'),

  ('custom_whatsapp_endpoint', '', 'Custom WhatsApp: full request URL'),
  ('custom_whatsapp_method', 'POST', 'Custom WhatsApp: HTTP method (POST or PUT)'),
  ('custom_whatsapp_auth_type', 'none', 'Custom WhatsApp: none, bearer, header or basic'),
  ('custom_whatsapp_auth_header', '', 'Custom WhatsApp: header name when auth_type is header'),
  ('custom_whatsapp_auth_value', '', 'Custom WhatsApp: token or header value'),
  ('custom_whatsapp_username', '', 'Custom WhatsApp: username for basic auth'),
  ('custom_whatsapp_password', '', 'Custom WhatsApp: password for basic auth'),
  ('custom_whatsapp_body', '', 'Custom WhatsApp: request body template, may use {{phone}} {{message}} {{from}}'),
  ('custom_whatsapp_phone_format', '+254', 'Custom WhatsApp: phone format, +254 or 254'),
  ('custom_whatsapp_sender', '', 'Custom WhatsApp: value substituted for {{from}}');