'use strict';

// Vercel serverless function -> GET /api/scan?mock=1
const { getScan } = require('../src/service');

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
    const result = await getScan({ mock: q.mock === '1' || q.mock === 'true' });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Internal error', detail: String(err && err.message) }));
  }
};
