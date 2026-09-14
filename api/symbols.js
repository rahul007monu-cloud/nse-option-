'use strict';

// Vercel serverless function -> GET /api/symbols
// Deliberately public: it is just the F&O instrument list (no market data), and
// the landing page uses it for the instrument count.
const { getSymbols } = require('../src/service');
const { send } = require('../src/http');

module.exports = (req, res) => {
  try {
    return send(res, 200, getSymbols());
  } catch (err) {
    return send(res, 500, { error: 'Internal error', detail: String(err && err.message) });
  }
};
