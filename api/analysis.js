'use strict';

// Vercel serverless function -> GET /api/analysis?symbol=NIFTY&mock=1&expiry=0
const { getAnalysis } = require('../src/service');

function query(req) {
  if (req.query) return req.query;
  try {
    return Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  } catch (_) {
    return {};
  }
}

module.exports = async (req, res) => {
  try {
    const q = query(req);
    const result = await getAnalysis({
      symbol: q.symbol || 'NIFTY',
      mock: q.mock === '1' || q.mock === 'true',
      expiryIndex: parseInt(q.expiry || '0', 10) || 0,
    });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Internal error', detail: String(err && err.message) }));
  }
};
