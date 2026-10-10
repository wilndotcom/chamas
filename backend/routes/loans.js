const express = require('express');
const router = express.Router();
const { authenticate, authenticateMember, authorize } = require('../middleware/auth');
const {
  getAllLoans,
  getMyLoans,
  applyForLoan,
  approveLoan,
  disburseLoan,
  recordRepayment,
  repayMyLoan,
  getPendingLoans
} = require('../controllers/loanController');

// Must be declared before '/pending' style paths to avoid id collisions.
router.get('/mine', authenticateMember, getMyLoans);
// A member repaying their own loan, in full or in part. The loan id is in the
// path and ownership is re-checked server-side.
router.post('/:id/pay', authenticateMember, repayMyLoan);

router.get('/', authenticate, authorize(['view_loans']), getAllLoans);
router.get('/pending', authenticate, authorize(['approve_loans']), getPendingLoans);
router.post('/apply', authenticateMember, applyForLoan);
router.post('/:id/approve', authenticate, authorize(['approve_loans']), approveLoan);
router.post('/:id/disburse', authenticate, authorize(['approve_loans']), disburseLoan);
router.post('/repayment', authenticate, authorize(['record_contributions']), recordRepayment);

module.exports = router;
