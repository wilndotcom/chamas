const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  getAllAdmins,
  createAdmin,
  updateAdmin,
  deleteAdmin,
  getRoles,
  getAuditLogs
} = require('../controllers/adminController');

router.get('/', authenticate, authorize(['manage_admins']), getAllAdmins);
router.post('/', authenticate, authorize(['manage_admins']), createAdmin);
router.put('/:id', authenticate, authorize(['manage_admins']), updateAdmin);
router.delete('/:id', authenticate, authorize(['manage_admins']), deleteAdmin);
router.get('/roles', authenticate, getRoles);
router.get('/audit-logs', authenticate, authorize(['view_audit_logs']), getAuditLogs);

module.exports = router;
