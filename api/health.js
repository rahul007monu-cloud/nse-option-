'use strict';

// Vercel serverless function -> GET /api/health
const { getHealth } = require('../src/service');

module.exports = async (req, res) => {
  const result = await getHealth();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.statusCode = 200;
  res.end(JSON.stringify(result));
};
