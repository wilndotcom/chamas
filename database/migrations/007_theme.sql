-- ============================================
-- THE TEAM — Migration 007
-- Appearance: colour skin and light/dark mode.
--
-- The skin is stored centrally rather than per browser so the whole chama
-- shares one look. Each admin can still override it locally.
-- ============================================

USE the_team_chama;

INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
('theme', 'emerald', 'Colour skin: emerald, ocean, sunset, forest, plum, slate'),
('color_mode', 'light', 'Colour mode: light or dark');