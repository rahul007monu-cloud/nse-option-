'use strict';

// Vercel serverless -> GET /api/plans
// Public: the landing page pricing table reads this.
const service = require('../src/service');
const { send } = require('../src/http');

module.exports = (req, res) => send(res, 200, service.getPublicPlans());
