const express = require('express');
const router = express.Router();
const { authenticate, authenticateMember } = require('../middleware/auth');
const { getTransparency } = require('../controllers/transparencyController');

/*
 * Group figures for the member portal.
 *
 * Deliberately available to members, not only to admins. A chama where members
 * cannot see the books is a chama where they have to take the treasurer's word
 * for it, which is where suspicion starts.
 *
 * Member-token only. Admins get these figures on the admin dashboard, and
 * routing them through the same place would mean one screen serving two very
 * different audiences.
 */
router.get('/', authenticateMember, getTransparency);

module.exports = router;