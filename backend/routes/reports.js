const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  getFinancialSummary,
  getMonthlyReport,
  getMemberStatement,
  getGrowthMetrics,
  getReminders,
  getExpenses,
  recordExpense,
  deleteExpense
} = require('../controllers/reportController');

router.get('/financial-summary', authenticate, authorize(['view_reports']), getFinancialSummary);
router.get('/monthly', authenticate, authorize(['view_reports']), getMonthlyReport);
router.get('/member/:member_id', authenticate, authorize(['view_reports']), getMemberStatement);

// Growth, interest and profit widgets
router.get('/growth', authenticate, authorize(['view_reports']), getGrowthMetrics);

// Members who have not paid / are behind / have an overdue loan.
// Visible to anyone who can send notifications (they need to chase people)
// as well as anyone who can view reports.
router.get(
  '/reminders',
  authenticate,
  authorize(['view_reports', 'send_notifications']),
  getReminders
);

// Expense tracking, needed for a real profit figure
router.get('/expenses', authenticate, authorize(['view_reports']), getExpenses);
router.post('/expenses', authenticate, authorize(['record_contributions']), recordExpense);
router.delete('/expenses/:id', authenticate, authorize(['record_contributions']), deleteExpense);

module.exports = router;