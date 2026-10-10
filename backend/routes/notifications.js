const express = require('express');
const router = express.Router();
const { authenticate, authenticateMember, authorize } = require('../middleware/auth');
const {
  getAllNotifications,
  sendNotification,
  sendBulkNotification,
  getMemberNotifications,
  sendReminders,
  testTemplate,
  getTemplateInfo,
  getChannelStatus,
  testChannel
} = require('../controllers/notificationController');

router.get('/', authenticate, authorize(['send_notifications']), getAllNotifications);
router.get('/my-notifications', authenticateMember, getMemberNotifications);
router.post('/send', authenticate, authorize(['send_notifications']), sendNotification);
router.post('/send-bulk', authenticate, authorize(['send_notifications']), sendBulkNotification);
router.post('/remind', authenticate, authorize(['send_notifications']), sendReminders);

// Template editor support: metadata + placeholder list, preview, and test send
router.get('/templates', authenticate, authorize(['send_notifications']), getTemplateInfo);
router.post('/templates/test', authenticate, authorize(['send_notifications']), testTemplate);

/*
 * Channel configuration, used by Settings.
 *
 * `system_settings` rather than `send_notifications`: reading this does not send
 * anything, but it reports whether a usable API key is present, which is a
 * credential-adjacent fact. An admin who can message members does not
 * automatically need to see which keys are configured.
 *
 * `testChannel` sends a real message to a real phone number, so it needs both:
 * permission to send, and permission over the configuration that authorises it.
 */
router.get(
  '/channels',
  authenticate,
  authorize(['system_settings']),
  getChannelStatus
);

router.post(
  '/channels/test',
  authenticate,
  authorize(['system_settings', 'send_notifications']),
  testChannel
);

module.exports = router;