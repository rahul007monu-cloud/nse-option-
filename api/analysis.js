'use strict';

// Vercel serverless function -> GET /api/analysis?symbol=NIFTY&mock=1&expiry=0
// Requires a logged-in session with the `chain` feature.
const service = require('../src/service');
const { query, send, sendDenied } = require('../src/http');

module.exports = async (req, res) => {
  try {
    const gate = service.authorize(req, 'chain');
    if (!gate.ok) return sendDenied(res, gate);

    const q = query(req);
    const result = await service.getAnalysis({
      symbol: q.symbol || 'NIFTY',
      mock: q.mock === '1' || q.mock === 'true',
      expiryIndex: parseInt(q.expiry || '0', 10) || 0,
      features: service.featuresFor(gate.user),
    });
    return send(res, 200, result);
  } catch (err) {
    return send(res, 500, { error: 'Internal error', detail: String(err && err.message) });
  }
};
