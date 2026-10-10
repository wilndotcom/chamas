-- ============================================
-- THE TEAM — Migration 004
-- Editable notification templates, one place each.
--
-- Six notification moments:
--   account created / welcome / 7-day / 3-day / 1-day reminders / due date
--
-- Safe to run more than once.
-- ============================================

USE the_team_chama;

INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
('tpl_account_created',
 'Hello {{member_name}}, your {{chama_name}} membership has been approved. You can now log in with {{phone}}. Your monthly contribution is KES {{monthly_contribution}}, payable by the {{reminder_day}} of each month.',
 'SMS/WhatsApp: membership approved, sent when admin approves a registration'),

('tpl_welcome',
 'Welcome to {{chama_name}}, {{member_name}}! We are glad to have you. Please pay your monthly contribution of KES {{monthly_contribution}} by the {{reminder_day}} of every month using M-Pesa paybill {{paybill}}. Kindly confirm receipt with the treasurer.',
 'SMS/WhatsApp: welcome message sent after approval'),

('tpl_loan_due',
 '{{member_name}}, your {{chama_name}} loan of KES {{balance}} falls due today, {{due_date}}. Please pay KES {{amount_due}} on time. Thank you.',
 'SMS/WhatsApp: sent on the loan due date'),

('tpl_due_7days',
 'Reminder: {{member_name}}, your loan of KES {{balance}} is due in 7 days on {{due_date}}. Please begin arranging KES {{amount_due}}.',
 'SMS/WhatsApp: early reminder 7 days before due date'),

('tpl_due_3days',
 'Final reminder: {{member_name}}, your {{chama_name}} loan of KES {{balance}} is due in 3 days on {{due_date}}. Outstanding amount is KES {{amount_due}}.',
 'SMS/WhatsApp: urgent reminder 3 days before due date'),

('tpl_due_1day',
 'Last day: {{member_name}}, your loan of KES {{balance}} is due TOMORROW, {{due_date}}. Please pay KES {{amount_due}} today to avoid penalties.',
 'SMS/WhatsApp: last warning 1 day before due date');