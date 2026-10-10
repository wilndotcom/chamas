const express = require('express');
const router = express.Router();
const { authenticate, requireSuperAdmin } = require('../middleware/auth');
const {
  getRoles,
  setRolePermissions,
  createRole,
  updateRole,
  deleteRole,
  getAdminOverrides,
  setAdminOverrides
} = require('../controllers/rolesController');

// Only the super admin can reshape who can do what. This is deliberately
// stricter than a manage_admins permission: handing out rights is a different
// job from creating admin accounts.
router.get('/', authenticate, requireSuperAdmin, getRoles);
router.post('/', authenticate, requireSuperAdmin, createRole);
router.put('/:id', authenticate, requireSuperAdmin, updateRole);
router.put('/:id/permissions', authenticate, requireSuperAdmin, setRolePermissions);
router.delete('/:id', authenticate, requireSuperAdmin, deleteRole);

module.exports = router;