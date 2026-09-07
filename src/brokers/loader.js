'use strict';

/**
 * loader.js — wire a broker adapter into the data layer.
 *
 * Priority:
 *   1. BROKER_MODULE env  -> load that custom adapter
 *   2. Angel One creds set (env or Admin panel) -> load brokers/angelone.js
 *
 * reloadBroker() is called after the Admin panel saves credentials, so the
 * live source turns on without a restart.
 */

const path = require('path');
const nse = require('../nse');
const { getCredentials } = require('../credentials');

let state = { loaded: false, name: null };

function register(adapter, name) {
  if (adapter && typeof adapter.fetchChain === 'function') nse.setBrokerFetcher(adapter.fetchChain);
  if (adapter && typeof adapter.fetchDaily === 'function') nse.setHistoryFetcher(adapter.fetchDaily);
  state = { loaded: true, name };
}

function loadBroker() {
  // 1) explicit custom module
  const mod = process.env.BROKER_MODULE;
  if (mod) {
    try {
      const resolved = path.isAbsolute(mod) ? mod : path.join(process.cwd(), mod);
      register(require(resolved), mod);
      console.log(`[broker] adapter loaded: ${mod}`);
      return state;
    } catch (e) {
      console.warn(`[broker] failed to load "${mod}": ${e.message}`);
    }
  }
  // 2) Angel One if credentials are configured
  if (getCredentials()) {
    try {
      register(require('../../brokers/angelone.js'), 'angelone');
      console.log('[broker] Angel One SmartAPI adapter active');
      return state;
    } catch (e) {
      console.warn('[broker] Angel adapter load failed: ' + e.message);
    }
  }
  return state;
}

function reloadBroker() {
  state = { loaded: false, name: null };
  nse.setBrokerFetcher(null);
  nse.setHistoryFetcher(null);
  return loadBroker();
}

function brokerStatus() { return state; }

module.exports = { loadBroker, reloadBroker, brokerStatus };
