const express = require('express');
const router = express.Router();
const { authenticateEither, authenticate, authorize } = require('../middleware/auth');
const { listGateways, updateGateway } = require('../controllers/paymentGatewayController');

// Both portals need this: the member payment forms build their method list from
// it, so the options match what the admin has switched on.
router.get('/', authenticateEither, listGateways);

router.put('/:key', authenticate, authorize(['system_settings']), updateGateway);

module.exports = router;