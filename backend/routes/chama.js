const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { getProfile, getLogo, uploadLogo, deleteLogo } = require('../controllers/chamaController');

// A logo arrives as base64 in JSON, so it needs roughly a third more room than
// the image itself. The global express.json() limit stays at its 100KB default
// deliberately: raising it app-wide would loosen every other endpoint, and this
// one needs to accept more.
const upload = express.json({ limit: '1mb' });

// Public: the browser needs the logo before anyone signs in, to render the
// sign-in screen. There is nothing sensitive here — it is a logo.
router.get('/logo', getLogo);
router.get('/profile', getProfile);

router.put('/logo', upload, authenticate, authorize(['system_settings']), uploadLogo);
router.delete('/logo', authenticate, authorize(['system_settings']), deleteLogo);

module.exports = router;