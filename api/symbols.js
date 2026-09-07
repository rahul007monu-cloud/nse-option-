'use strict';

// Vercel serverless function -> GET /api/symbols
const { getSymbols } = require('../src/service');

module.exports = (req, res) => {
  try {
    const result = getSymbols();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=3600'); // list rarely changes
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Internal error', detail: String(err && err.message) }));
  }
};
