const express = require('express');
const router = express.Router();
const { authenticate, requireSuperAdmin } = require('../middleware/auth');
const {
  getAdminOverrides,
  setAdminOverrides
} = require('../controllers/rolesController');

/**
 * Per-admin permission overrides, mounted at /api/admin-permissions.
 *
 * Kept separate from /api/roles so the id in the path is unambiguously an
 * ADMIN id, not a role id.
 */
router.get('/:adminId', authenticate, requireSuperAdmin, getAdminOverrides);
router.put('/:adminId', authenticate, requireSuperAdmin, setAdminOverrides);

module.exports = router;