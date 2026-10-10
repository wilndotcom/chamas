const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  stkPush,
  stkTestPrompt,
  mpesaCallback,
  registerC2BUrls,
  c2bConfirmation,
  c2bValidation,
  mpesaStatus
} = require('../controllers/mpesaController');

/*
 * The callbacks are deliberately unauthenticated.
 *
 * Safaricom posts to these with no credentials of ours, so they cannot be behind
 * the usual token check. They are instead identified by the transaction ID they
 * quote, which only Safaricom and this server have seen. Locking them behind auth
 * would mean Safaricom's confirmation is rejected and every payment stays
 * "pending" forever.
 */

// Paybill callbacks. Must be registered with Safaricom by the operator; the
// "Register paybill URLs" button in Settings posts /register-c2b to do it.
router.post('/confirmation', c2bConfirmation);
router.post('/validation', c2bValidation);

// STK Push callback: Safaricom delivers the result of a prompt here.
router.post('/callback', mpesaCallback);

/*
 * An STK prompt sends a real payment request to a real phone. `authenticate`
 * already limits this to admins; the permission check stops a lower-privileged
 * admin such as a secretary from sending prompts to arbitrary numbers and
 * recording nothing.
 */
router.post('/stk-push', authenticate, authorize(['record_contributions']), stkPush);

/*
 * Test prompt: same Daraja call, nothing recorded.
 *
 * Restricted to system_settings because it exists to verify the Daraja setup, not
 * to collect money, and it accepts any phone number.
 */
router.post(
  '/test-prompt',
  authenticate,
  authorize(['system_settings']),
  stkTestPrompt
);

// Registers the paybill's validation and confirmation URLs with Safaricom. Only
// Safaricom can accept the change, so this cannot be done from the form itself.
router.post(
  '/register-c2b',
  authenticate,
  authorize(['system_settings']),
  registerC2BUrls
);

// Shows which credentials are actually in use, so Settings can be verified
// against the API rather than against the form.
router.get('/status', authenticate, mpesaStatus);

module.exports = router;