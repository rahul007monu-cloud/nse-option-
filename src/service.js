'use strict';

/**
 * service.js
 * -----------------------------------------------------------------------------
 * Shared application logic used by BOTH the local HTTP server (server.js) and
 * the Vercel serverless functions (api/*.js). Keeping it here means the two
 * deployment targets never drift apart.
 *
 * NOTE: no in-memory chart history lives here. On serverless (Vercel) each
 * request may hit a fresh instance, so the price/momentum chart history is
 * accumulated on the CLIENT (see public/app.js). This keeps behaviour identical
 * locally and in production.
 * -----------------------------------------------------------------------------
 */

const nse = require('./nse');
const { analyze } = require('./analysis');

async function getHealth() {
  return {
    ok: true,
    service: 'nse-option-analyzer',
    time: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
  };
}

function getSymbols() {
  return nse.listSymbols();
}

/**
 * Full analysis for a symbol.
 * @param {object} q { symbol, mock (bool), expiryIndex (number) }
 */
async function getAnalysis(q = {}) {
  const symbol = (q.symbol || 'NIFTY').toUpperCase();
  const preferMock = !!q.mock;
  const expiryIndex = Number.isFinite(q.expiryIndex) ? q.expiryIndex : 0;

  const [chain, daily] = await Promise.all([
    nse.getOptionChain(symbol, { preferMock, expiryIndex }),
    nse.getDailyHistory(symbol, { preferMock }),
  ]);
  return analyze(chain, { daily });
}

module.exports = { getHealth, getSymbols, getAnalysis };
