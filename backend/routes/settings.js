const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  getAllSettings,
  updateSettings,
  updateSetting,
  getPublicSettings,
  getAbout
} = require('../controllers/settingsController');

router.get('/public', getPublicSettings);
// Registered before '/' so "about" is not swallowed by the id-less lookup.
router.get('/about', authenticate, authorize(['system_settings']), getAbout);
router.get('/', authenticate, authorize(['system_settings']), getAllSettings);
// Bulk save for a whole card, in one transaction.
router.put('/', authenticate, authorize(['system_settings']), updateSettings);
router.put('/:key', authenticate, authorize(['system_settings']), updateSetting);

module.exports = router;
