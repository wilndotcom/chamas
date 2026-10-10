-- ============================================
-- THE TEAM — Migration 006
-- Language, currency and number formatting.
--
-- Lets an admin present amounts the way their group writes them, e.g.
--   KSh 1,250.50   (en, symbol before, dot decimal, comma thousands)
--   1.250,50 KSh   (pt/de style)
--   1 250,50 KSh   (fr style, space thousands)
--
-- Safe to run more than once.
-- ============================================

USE the_team_chama;

INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
('language', 'en', 'Interface language'),
('currency', 'KES', 'Currency ISO code, e.g. KES, USD, TZS, UGX'),
('currency_symbol', 'KSh', 'Symbol shown beside amounts, e.g. KSh, $, €'),
('symbol_position', 'before', 'Where the symbol sits: before or after the amount'),
('decimal_separator', '.', 'Decimal separator: . or ,'),
('thousand_separator', ',', 'Thousands separator: , . or a space');