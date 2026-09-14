'use strict';

// Vercel serverless function -> GET /api/scan?mock=1
// Requires a logged-in session with the `scanner` feature. This endpoint sweeps
// the whole F&O universe, so leaving it open was both a paywall hole and an
// easy way for anyone to burn the deployment's compute.
const service = require('../src/service');
const { query, send, sendDenied } = require('../src/http');

module.exports = async (req, res) => {
  try {
    const gate = service.authorize(req, 'scanner');
    if (!gate.ok) return sendDenied(res, gate);

    const q = query(req);
    const result = await service.getScan({ mock: q.mock === '1' || q.mock === 'true' });
    return send(res, 200, result);
  } catch (err) {
    return send(res, 500, { error: 'Internal error', detail: String(err && err.message) });
  }
};
