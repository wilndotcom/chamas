const express = require('express');
const router = express.Router();
const {
  adminLogin,
  memberLogin,
  memberRegister,
  getAdminProfile,
  getMemberProfile,
  changePassword,
  getImpersonationTargets,
  impersonate,
  refreshToken
} = require('../controllers/authController');
const { authenticate, authenticateMember, requireSuperAdmin } = require('../middleware/auth');

router.post('/admin-login', adminLogin);
router.post('/member-login', memberLogin);
router.post('/register', memberRegister);
router.get('/profile', authenticate, getAdminProfile);
router.get('/member-profile', authenticateMember, getMemberProfile);
router.put('/change-password', authenticateEither, changePassword);

/*
 * Sliding session renewal.
 *
 * The client calls this after each successful profile load, so an active user's
 * expiry keeps moving forward instead of stopping them at a fixed 24 hours. Left
 * out, the session simply ended once a day no matter how much the app was used,
 * which was the other half of "I have to log in every time".
 *
 * Deliberately not behind `authenticate`: that middleware rejects an expired
 * token with 401, and an expired token is exactly the one case this endpoint
 * cannot help with. The handler re-verifies the token itself and checks the
 * account is still active, so this renews a session rather than minting one.
 */
router.post('/refresh', refreshToken);

// Super admin portal switching
router.get('/impersonation-targets', authenticate, requireSuperAdmin, getImpersonationTargets);
router.post('/impersonate', authenticate, requireSuperAdmin, impersonate);

module.exports = router;