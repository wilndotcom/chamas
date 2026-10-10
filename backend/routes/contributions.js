const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  getAllContributions,
  recordContribution,
  getMemberContributions,
  getContributionSummary
} = require('../controllers/contributionController');

router.get('/', authenticate, authorize(['view_members']), getAllContributions);
router.get('/summary', authenticate, authorize(['view_reports']), getContributionSummary);
router.get('/member/:member_id', authenticate, authorize(['view_members']), getMemberContributions);
router.post('/', authenticate, authorize(['record_contributions']), recordContribution);

module.exports = router;
