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
  impersonate
} = require('../controllers/authController');
const { authenticate, authenticateMember, requireSuperAdmin } = require('../middleware/auth');

router.post('/admin-login', adminLogin);
router.post('/member-login', memberLogin);
router.post('/register', memberRegister);
router.get('/profile', authenticate, getAdminProfile);
router.get('/member-profile', authenticateMember, getMemberProfile);
router.put('/change-password', authenticate, changePassword);

// Super admin portal switching
router.get('/impersonation-targets', authenticate, requireSuperAdmin, getImpersonationTargets);
router.post('/impersonate', authenticate, requireSuperAdmin, impersonate);

module.exports = router;