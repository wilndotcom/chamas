const pool = require('../config/database');

/**
 * Chama branding: the logo.
 *
 * The logo is stored as raw image bytes in `chama_profile` and served back over
 * GET /api/chama/logo. Storing bytes rather than a file path means a deployment
 * needs no writable upload directory and no extra nginx rule, and the logo
 * survives a rebuild.
 *
 * Uploads arrive as base64 in JSON rather than multipart, which keeps the
 * dependency list unchanged and means the browser can preview the result before
 * anything is sent.
 *
 * The name is NOT handled here. It lives in `settings.chama_name` and is already
 * exposed by /api/settings/public, so the interface reads it from there.
 */

const MAX_BYTES = 512 * 1024; // a logo should never need more than half a megabyte
const MAX_BASE64_CHARS = Math.ceil((MAX_BYTES * 4) / 3) + 16; // what that costs once encoded

/**
 * Detects the real image type from its magic bytes.
 *
 * The browser-supplied MIME type is a hint from an untrusted client and is
 * ignored for validation: a renamed executable would otherwise pass. Supported:
 * PNG, JPEG, GIF, WebP.
 */
const sniffImage = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // GIF: "GIF87a" or "GIF89a"
  const head = buffer.slice(0, 6).toString('ascii');
  if (head === 'GIF87a' || head === 'GIF89a') {
    return 'image/gif';
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
};

/** Public: whether a logo is set, and when it last changed. */
const getProfile = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT logo_mime, logo_updated_at FROM chama_profile WHERE id = 1'
    );
    const row = rows[0] || {};

    res.json({
      has_logo: !!row.logo_mime,
      mime: row.logo_mime || null,
      updated_at: row.logo_updated_at || null,
      // The URL is stable; the timestamp lets the client bust the cache.
      logo_url: row.logo_mime ? '/api/chama/logo' : null
    });
  } catch (error) {
    console.error('Chama profile error:', error);
    res.status(500).json({ error: 'Failed to read the chama profile.' });
  }
};

/**
 * Public: the logo bytes.
 *
 * Cached hard, because the URL never changes for a given logo and the response
 * carries its own freshness value. `?v=` busts it after an upload.
 */
const getLogo = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT logo_data, logo_mime, logo_updated_at FROM chama_profile WHERE id = 1'
    );

    const row = rows[0];
    if (!row || !row.logo_data) {
      // 404 rather than an empty body, so an <img> onError can fall back to
      // the built-in mark.
      return res.status(404).json({ error: 'No logo set.' });
    }

    // Stored as base64 text, so it must be decoded explicitly. A TEXT column
    // hands back a character string, and treating that as raw bytes corrupts
    // anything above 0x7F: a 51,160-byte PNG came back as 51,214 bytes of
    // mojibake that no decoder would accept.
    const buffer = Buffer.from(String(row.logo_data), 'base64');
    if (buffer.length === 0) {
      return res.status(404).json({ error: 'No logo set.' });
    }

    res.setHeader('Content-Type', row.logo_mime || 'application/octet-stream');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (row.logo_updated_at) {
      res.setHeader('Last-Modified', new Date(row.logo_updated_at).toUTCString());
    }
    res.end(buffer);
  } catch (error) {
    console.error('Chama logo error:', error);
    res.status(500).json({ error: 'Failed to read the logo.' });
  }
};

/** Admin: store a new logo. */
const uploadLogo = async (req, res) => {
  try {
    const { data, filename } = req.body || {};

    if (!data) {
      return res.status(400).json({ error: 'No image was sent.' });
    }

    // Accepts either a bare base64 string or a full data URL.
    const base64 = String(data).includes(',')
      ? String(data).split(',').pop()
      : String(data);

    if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
      return res.status(400).json({ error: 'That file is not a readable image.' });
    }

    const buffer = Buffer.from(base64, 'base64');

    if (buffer.length === 0) {
      return res.status(400).json({ error: 'That file appears to be empty.' });
    }
    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({
        error: `Logo is ${Math.round(buffer.length / 1024)}KB. Keep it under 512KB — resizing it ` +
          'usually gets it under 50KB.'
      });
    }

    const mime = sniffImage(buffer);
    if (!mime) {
      return res.status(400).json({
        error: 'Only PNG, JPEG, GIF and WebP images are accepted.'
      });
    }

    // Store the base64 TEXT, not the raw bytes.
    //
    // logo_data is a TEXT column, so mysql2 hands it back as a character
    // string. Writing raw binary into it and reading it back without decoding
    // silently corrupts every byte above 0x7F, because MySQL and Node both
    // reinterpret the column through the connection charset. Base64 is plain
    // ASCII and survives the round trip untouched.
    const encoded = buffer.toString('base64');
    if (encoded.length > MAX_BASE64_CHARS) {
      return res.status(400).json({ error: 'Logo is too large.' });
    }

    await pool.execute(
      `INSERT INTO chama_profile (id, logo_data, logo_mime, logo_filename, logo_updated_at)
       VALUES (1, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         logo_data = VALUES(logo_data),
         logo_mime = VALUES(logo_mime),
         logo_filename = VALUES(logo_filename),
         logo_updated_at = NOW()`,
      [encoded, mime, (filename || 'logo').slice(0, 255)]
    );

    res.json({
      success: true,
      mime,
      bytes: buffer.length,
      message: 'Logo saved. It now appears in the header, sidebar and sign-in screen.'
    });
  } catch (error) {
    console.error('Chama logo upload error:', error);
    res.status(500).json({ error: 'Failed to save the logo.' });
  }
};

/** Admin: remove the logo and fall back to the built-in mark. */
const deleteLogo = async (req, res) => {
  try {
    await pool.execute(
      'UPDATE chama_profile SET logo_data = NULL, logo_mime = NULL, logo_filename = NULL, logo_updated_at = NULL WHERE id = 1'
    );
    res.json({ success: true, message: 'Logo removed.' });
  } catch (error) {
    console.error('Chama logo delete error:', error);
    res.status(500).json({ error: 'Failed to remove the logo.' });
  }
};

module.exports = { getProfile, getLogo, uploadLogo, deleteLogo, MAX_BYTES };