'use strict';

/**
 * example-adapter.js — TEMPLATE for wiring a real broker / data vendor.
 *
 * Copy this file (e.g. to brokers/zerodha.js), fill in the API calls for your
 * broker, then run:
 *
 *   BROKER_MODULE=./brokers/zerodha.js node server.js
 *
 * You must return data in the SAME normalised shape the app uses everywhere.
 * IV is in PERCENT (e.g. 13.5), OI/volume are plain numbers, prices in INR.
 *
 * Works with any provider that gives you an option chain + LTP + OI + IV, e.g.
 * Zerodha Kite, Fyers, Upstox, Angel One SmartAPI, Dhan, or a paid data vendor.
 * Keep secrets in env vars — never hard‑code API keys.
 */

// const KiteConnect = require('kiteconnect').KiteConnect; // example dependency

/**
 * Return the option chain for `symbol` (and optional `expiry` like "25-Sep-2026").
 * @returns {Promise<object>} normalised chain
 */
async function fetchChain(symbol, expiry) {
  // 1) Call your broker API here to get spot + per-strike CE/PE quotes.
  //    Below is a hard‑coded illustration of the REQUIRED output shape.
  //    Replace it with real data from your broker.

  // const kite = new KiteConnect({ api_key: process.env.KITE_API_KEY });
  // kite.setAccessToken(process.env.KITE_ACCESS_TOKEN);
  // ...build rows from kite.getQuote(instrumentTokens)...

  throw new Error(
    'example-adapter is a template — implement fetchChain() with your broker API'
  );

  /* Expected return shape:
  return {
    source: 'broker',
    symbol,
    type: 'index',                     // or 'stock'
    underlyingValue: 24800,            // spot
    timestamp: new Date().toISOString(),
    expiry: expiry || '25-Sep-2026',
    expiryDates: ['25-Sep-2026', '02-Oct-2026'],
    rows: [
      {
        strikePrice: 24800,
        CE: { openInterest, changeinOpenInterest, totalTradedVolume, impliedVolatility, lastPrice },
        PE: { openInterest, changeinOpenInterest, totalTradedVolume, impliedVolatility, lastPrice },
      },
      // ...more strikes...
    ],
  };
  */
}

/**
 * Optional: daily closes (oldest -> newest) for the DEMA levels.
 * If you don't implement this, the app uses its own mock daily series.
 * @returns {Promise<number[]>}
 */
async function fetchDaily(symbol) {
  // return await myVendor.getDailyCloses(symbol, 220);
  return null;
}

module.exports = { fetchChain, fetchDaily };
