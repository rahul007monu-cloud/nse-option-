'use strict';

/**
 * loader.js — optionally load a broker/data-vendor adapter at startup.
 *
 * Set the BROKER_MODULE env var to the path of a module that exports:
 *   - fetchChain(symbol, expiry) -> normalised option-chain object
 *   - fetchDaily(symbol)         -> array of daily close prices (optional)
 *
 * Example:
 *   BROKER_MODULE=./brokers/zerodha.js node server.js
 *
 * This is the reliable way to get real-time data from ANY host (including
 * Vercel), because it uses YOUR authenticated broker session, not NSE's
 * public site (which blocks datacenter IPs).
 */

const path = require('path');
const nse = require('../nse');

let loaded = false;

function loadBroker() {
  if (loaded) return true;
  const mod = process.env.BROKER_MODULE;
  if (!mod) return false;
  try {
    const resolved = path.isAbsolute(mod) ? mod : path.join(process.cwd(), mod);
    const adapter = require(resolved);
    if (typeof adapter.fetchChain === 'function') nse.setBrokerFetcher(adapter.fetchChain);
    if (typeof adapter.fetchDaily === 'function') nse.setHistoryFetcher(adapter.fetchDaily);
    loaded = true;
    console.log(`[broker] adapter loaded: ${mod}`);
    return true;
  } catch (e) {
    console.warn(`[broker] failed to load "${mod}": ${e.message}`);
    return false;
  }
}

module.exports = { loadBroker };
