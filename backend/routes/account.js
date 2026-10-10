const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate } = require('../middleware/auth');
const {
  requestPasswordReset,
  completePasswordReset,
  issueTwoFactorCode,
  verifyTwoFactorCode,
  setTwoFactor
} = require('../controllers/accountController');

const router = express.Router();

/*
 * Rate limiting, on its own counter and separate from login.
 *
 * A reset code is six digits, so without this it would be a far cheaper thing
 * to guess than a password: limiting login attempts protects work that bcrypt
 * makes expensive, while an unlimited reset flow protects nothing at all.
 */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' }
});

// Open, because a locked-out user has no token to present.
router.post('/request-reset', limiter, requestPasswordReset);
router.post('/complete-reset', limiter, completePasswordReset);

/*
 * Two-factor code for an admin part-way through signing in.
 *
 * Takes the admin id in the body rather than from a token, because at this point
 * the password has been accepted but the session is not yet trusted.
 *
 * The handler still reads the enabled flag from the database, so a caller cannot
 * pass someone's id and skip their second factor.
 */
router.post('/request-code', limiter, (req, res, next) => {
  const adminId = Number(req.body.admin_id);
  if (!Number.isInteger(adminId) || adminId <= 0) {
    return res.status(400).json({ error: 'An administrator is required.' });
  }
  // Minimal object with the shape the handler expects, rather than spreading the
  // live request: Express requests are prototype-based and do not copy cleanly.
  issueTwoFactorCode({ user: { id: adminId } }, res).catch(next);
});

router.post('/verify-code', authenticate, verifyTwoFactorCode);
router.post('/two-factor', authenticate, setTwoFactor);

module.exports = router;