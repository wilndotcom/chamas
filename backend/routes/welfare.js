const express = require('express');
const router = express.Router();
const { authenticate, authenticateMember, authorize } = require('../middleware/auth');
const {
  getAllWelfareContributions,
  recordWelfareContribution,
  getWelfareRequests,
  submitWelfareRequest,
  approveWelfareRequest,
  rejectWelfareRequest
} = require('../controllers/welfareController');

router.get('/contributions', authenticate, authorize(['view_members']), getAllWelfareContributions);
router.post('/contributions', authenticate, authorize(['record_contributions']), recordWelfareContribution);
router.get('/requests', authenticate, authorize(['manage_welfare']), getWelfareRequests);
router.post('/requests', authenticateMember, submitWelfareRequest);
router.post('/requests/:id/approve', authenticate, authorize(['manage_welfare']), approveWelfareRequest);
router.post('/requests/:id/reject', authenticate, authorize(['manage_welfare']), rejectWelfareRequest);

module.exports = router;
