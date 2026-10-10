const express = require('express');
const router = express.Router();
const { authenticateEither } = require('../middleware/auth');
const { getMyLanguage, setMyLanguage } = require('../controllers/preferencesController');

// Both portals read and write their own preference, so either token is accepted.
// The handler picks the table from the token type, never from the request body.
router.get('/language', authenticateEither, getMyLanguage);
router.put('/language', authenticateEither, setMyLanguage);

module.exports = router;