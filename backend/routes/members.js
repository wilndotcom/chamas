const express = require('express');
const router = express.Router();
const { authenticate, authenticateMember, authorize } = require('../middleware/auth');
const {
  getAllMembers,
  getMember,
  createMember,
  updateMember,
  deleteMember,
  setMemberStatus,
  getMemberDashboard,
  getPendingMembers,
  approveMember,
  rejectMember
} = require('../controllers/memberController');

router.get('/', authenticate, authorize(['view_members']), getAllMembers);
router.get('/dashboard', authenticateMember, getMemberDashboard);

// NOTE: must be declared before '/:id' or Express would match it as an id.
router.get('/registrations', authenticate, authorize(['manage_members']), getPendingMembers);
router.post(
  '/registrations/:id/approve',
  authenticate,
  authorize(['manage_members']),
  approveMember
);
router.post(
  '/registrations/:id/reject',
  authenticate,
  authorize(['manage_members']),
  rejectMember
);

router.get('/:id', authenticate, authorize(['view_members']), getMember);
router.post('/', authenticate, authorize(['manage_members']), createMember);
router.put('/:id', authenticate, authorize(['manage_members']), updateMember);
router.patch('/:id/status', authenticate, authorize(['manage_members']), setMemberStatus);
router.delete('/:id', authenticate, authorize(['manage_members']), deleteMember);

module.exports = router;