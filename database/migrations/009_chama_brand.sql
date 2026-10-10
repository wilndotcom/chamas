-- ============================================
-- CHAMA BRANDING (logo)
-- ============================================
-- The chama name already lives in `settings` and is already read by the
-- notification and reminder code. This table holds the logo only.
--
-- The logo is stored as raw image bytes rather than a file path so that a
-- deployment needs no writable upload directory and no extra nginx rule: the
-- bytes survive rebuilds, rsyncs and multiple app instances unchanged.
--
-- MEDIUMTEXT is required because even a small PNG or JPEG exceeds the 64KB a
-- plain TEXT column allows.
--
-- Idempotent: safe to replay during a deploy.

CREATE TABLE IF NOT EXISTS chama_profile (
    id INT AUTO_INCREMENT PRIMARY KEY,
    logo_data MEDIUMTEXT NULL,
    logo_mime VARCHAR(100) NULL,
    logo_filename VARCHAR(255) NULL,
    logo_updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Exactly one brand row, so a lookup never has to guess which one is current.
INSERT IGNORE INTO chama_profile (id) VALUES (1);