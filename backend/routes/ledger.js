const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  getCashBook,
  recordLedgerEntry,
  deleteLedgerEntry
} = require('../controllers/ledgerController');

// Cash book: money in, money out and the resulting balance
router.get('/cashbook', authenticate, authorize(['view_reports']), getCashBook);

// Manual entries for money with no other home (interest collected in cash,
// donations, fines, stationery bought directly)
// NB: this router is mounted at /api/ledger, so paths are relative to that.
router.post('/', authenticate, authorize(['record_contributions']), recordLedgerEntry);
router.delete('/:id', authenticate, authorize(['record_contributions']), deleteLedgerEntry);

module.exports = router;