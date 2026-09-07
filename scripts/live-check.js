'use strict';

/**
 * live-check.js — quick "is live NSE data reachable from THIS machine?" test.
 *
 * Usage:
 *   node scripts/live-check.js            # checks NIFTY
 *   node scripts/live-check.js RELIANCE   # checks a stock
 *
 * It forces the LIVE path (skips mock) and tells you exactly what happened, so
 * you can confirm real data before market open.
 */

const nse = require('../src/nse');

const symbol = (process.argv[2] || 'NIFTY').toUpperCase();

(async () => {
  const mkt = nse.marketStatus();
  console.log('\n──────────────────────────────────────────────');
  console.log('  NSE LIVE DATA CHECK');
  console.log('──────────────────────────────────────────────');
  console.log(`  Symbol      : ${symbol}`);
  console.log(`  Market (IST): ${mkt.status}  (${mkt.ist.toISOString().slice(11, 16)} UTC-based IST)`);
  console.log('  Trying LIVE NSE (mock disabled)…\n');

  const t0 = Date.now();
  try {
    const chain = await nse.getOptionChain(symbol, { preferMock: false });
    const ms = Date.now() - t0;
    if (chain.source === 'live') {
      console.log(`  ✅ LIVE DATA OK  (${ms} ms)`);
      console.log(`     Spot        : ${chain.underlyingValue}`);
      console.log(`     Expiry      : ${chain.expiry}`);
      console.log(`     Strikes     : ${chain.rows.length}`);
      console.log('\n  Great — run "node server.js" and open http://localhost:3000');
      console.log('  (leave the "Mock" box unticked to see this live data).');
    } else if (chain.source === 'broker') {
      console.log(`  ✅ BROKER DATA OK (${ms} ms) — using your configured broker feed.`);
    } else {
      console.log(`  ⚠️  Fell back to MOCK (${ms} ms). Live NSE was NOT reachable from here.`);
      console.log('     Common reasons:');
      console.log('       • You are on a cloud host (Vercel/AWS) — NSE blocks datacenter IPs.');
      console.log('       • Network/proxy/firewall blocking nseindia.com.');
      console.log('     Fix: run this on your own PC/laptop, OR wire a broker feed');
      console.log('          (see README → "Use it live").');
    }
  } catch (e) {
    console.log(`  ❌ Live fetch error: ${e.message}`);
    console.log('     Run it from your own PC, or configure a broker feed (README).');
  }
  console.log('──────────────────────────────────────────────\n');
})();
