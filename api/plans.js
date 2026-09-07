'use strict';

// Vercel serverless -> GET /api/plans
const service = require('../src/service');

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=30');
  res.statusCode = 200;
  res.end(JSON.stringify(service.getPublicPlans()));
};
