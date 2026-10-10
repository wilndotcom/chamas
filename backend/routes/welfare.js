const express = require('express');
const router = express.Router();
const { authenticate, authenticateMember, authenticateEither, authorize } = require('../middleware/auth');
const {
  getAllWelfareContributions,
  recordWelfareContribution,
  getMyWelfare,
  getWelfareRequests,
  submitWelfareRequest,
  approveWelfareRequest,
  disburseWelfareRequest,
  rejectWelfareRequest,
  getWelfareFund
} = require('../controllers/welfareController');

/*
 * The member's own view of welfare.
 *
 * Before this existed a member could submit a request and then had no way to see
 * its outcome. That is the fastest way to lose people's trust in a fund, so the
 * member side is a first-class surface rather than an admin screen with the
 * member table filtered.
 */
router.get('/my', authenticateMember, getMyWelfare);

// Admin views of every member's welfare activity.
router.get('/contributions', authenticate, authorize(['view_members']), getAllWelfareContributions);
router.get('/requests', authenticate, authorize(['manage_welfare']), getWelfareRequests);

/*
 * Contributing to welfare.
 *
 * Both roles reach this endpoint. `recordWelfareContribution` reads `req.member`
 * to tell them apart: an admin names the member, and a member is always recorded
 * against their own id regardless of what the request body says. Two handlers
 * with the same name were avoided so the permission rule stays in one place.
 */
router.post('/contributions', authenticateEither, recordWelfareContribution);

// The fund's balance and the rules that govern it.
router.get('/fund', authenticate, getWelfareFund);

// A member asks for help.
router.post('/requests', authenticateMember, submitWelfareRequest);

/*
 * Approve and pay out are separate steps.
 *
 * Approval is the committee's decision; disbursement is the money moving.
 * Combining them made an approved request look paid while the cash was still in
 * the fund, which is exactly the sort of thing that erodes trust.
 */
router.post('/requests/:id/approve', authenticate, authorize(['manage_welfare']), approveWelfareRequest);
router.post('/requests/:id/disburse', authenticate, authorize(['manage_welfare']), disburseWelfareRequest);
router.post('/requests/:id/reject', authenticate, authorize(['manage_welfare']), rejectWelfareRequest);

module.exports = router;