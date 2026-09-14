#!/usr/bin/env node
'use strict';

/**
 * angel-check.js — verify Angel One SmartAPI credentials stage by stage.
 *
 *   node scripts/angel-check.js            # checks NIFTY
 *   node scripts/angel-check.js RELIANCE   # checks a stock
 *
 * Credentials are read exactly the way the app reads them (src/credentials.js):
 *   1. env vars  SMARTAPI_KEY / SMARTAPI_CLIENT / SMARTAPI_PIN / SMARTAPI_TOTP_SECRET
 *   2. data/credentials.json (what the Admin panel writes)
 *
 * Each stage prints PASS/FAIL with the raw Angel message on failure, so a bad
 * field can be pinpointed instead of guessing. Secrets are never printed.
 */

const cred = require('../src/credentials');
const { totp, base32Decode } = require('../src/totp');
const angel = require('../brokers/angelone');
const { ensureLogin, loadScrip, parseAngelExpiry, fmtExpiry, INDEX_TOKENS } = angel._internal;

const SYMBOL = (process.argv[2] || 'NIFTY').toUpperCase();

const ok = (m) => console.log('  \x1b[32m✅ ' + m + '\x1b[0m');
const bad = (m) => console.log('  \x1b[31m❌ ' + m + '\x1b[0m');
const info = (m) => console.log('  \x1b[90m' + m + '\x1b[0m');
const step = (n, m) => console.log(`\n\x1b[1m[${n}] ${m}\x1b[0m`);

function fail(msg, hints) {
  bad(msg);
  if (hints && hints.length) {
    console.log('\n  \x1b[33mSambhavit wajah:\x1b[0m');
    hints.forEach((h) => console.log('   • ' + h));
  }
  console.log('\n\x1b[31mCHECK FAILED\x1b[0m — upar wala message theek karke dobara chalao.\n');
  process.exit(1);
}

(async function main() {
  console.log('\n\x1b[1m🔌 Angel One SmartAPI — connection check\x1b[0m');
  console.log('   symbol: ' + SYMBOL);

  // -- 1. credentials present? ----------------------------------------------
  step(1, 'Credentials padh raha hoon');
  const creds = cred.getCredentials();
  if (!creds) {
    const st = cred.getStatus();
    bad('Credentials configured nahi hain (source: ' + st.source + ')');
    console.log(`
  Do tarike hain:

  A) Env vars ke saath seedha chalao:
     SMARTAPI_KEY=xxx SMARTAPI_CLIENT=A12345 SMARTAPI_PIN=1234 \\
     SMARTAPI_TOTP_SECRET=XXXXXXXX node scripts/angel-check.js

  B) Ya pehle Admin panel se save karo:
     node server.js  ->  http://localhost:3000/admin.html  ->  API tab
     (file: ${cred.CRED_PATH})
`);
    process.exit(1);
  }
  const st = cred.getStatus();
  ok(`Mil gaye (source: ${st.source})`);
  info(`apiKey ${st.masked.apiKey} · clientCode ${st.masked.clientCode} · mpin •••• · totpSecret ${st.masked.totpSecret}`);

  // -- 2. TOTP secret valid base32? -----------------------------------------
  step(2, 'TOTP secret check kar raha hoon');
  let code;
  try {
    const decoded = base32Decode(creds.totpSecret);
    if (decoded.length < 10) {
      fail(`TOTP secret sirf ${decoded.length} bytes me decode hua — bahut chhota hai`, [
        'Tumne 6-digit authenticator CODE daal diya hai, base32 SECRET ki jagah.',
        'Angel ke Enable-TOTP page pe QR ke saath jo lambi text string hai wo chahiye (~16-32 characters, A-Z aur 2-7).',
        'Agar wo string save nahi ki thi, TOTP dobara enable karke is baar text secret copy karo.',
      ]);
    }
    code = totp(creds.totpSecret);
    if (!/^\d{6}$/.test(code)) fail('TOTP generate hua par 6-digit nahi: ' + code, []);
    const left = 30 - (Math.floor(Date.now() / 1000) % 30);
    ok(`TOTP generate ho gaya: ${code}  (${left}s valid)`);
    info(`secret ${decoded.length} bytes me decode hua — theek lag raha hai`);
    info('Tip: ye code apne authenticator app se match karo. Match nahi kare to secret galat hai ya system clock off hai.');
  } catch (e) {
    fail('TOTP generate nahi ho paya: ' + e.message, [
      'Secret me base32 ke bahar ke characters ho sakte hain (sirf A-Z aur 2-7 allowed).',
    ]);
  }

  // -- 3. login -------------------------------------------------------------
  step(3, 'Login kar raha hoon (loginByPassword)');
  let jwt;
  const tLogin = Date.now();
  try {
    jwt = await ensureLogin(creds);
    ok(`Login OK (${Date.now() - tLogin}ms) · JWT mila (${String(jwt).length} chars)`);
  } catch (e) {
    const msg = String(e && e.message);
    const hints = [];
    if (/totp/i.test(msg)) {
      hints.push('TOTP secret galat hai, ya is machine ka clock IST/NTP se off hai (TOTP time-based hai).');
      hints.push('Clock check karo — 30 second ka drift bhi login fail kar deta hai.');
    }
    if (/password|mpin|invalid.*user/i.test(msg)) {
      hints.push('MPIN chahiye (4-digit), tumhara login PASSWORD nahi.');
      hints.push('clientCode tumhara Angel login ID hai (jaise A12345), email nahi.');
    }
    if (/key|private|forbidden|401|403/i.test(msg)) {
      hints.push('API key galat, ya SmartAPI app ka type match nahi kar raha (Market Feeds / Trading APIs).');
      hints.push('smartapi.angelone.in pe app active hai ye confirm karo.');
    }
    if (/timeout|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|socket disconnected|TLS|ECONNRESET|certificate/i.test(msg)) {
      hints.push('Network se apiconnect.angelone.in tak nahi pahunch pa raha — internet / firewall / proxy check karo.');
    }
    if (!hints.length) hints.push('Angel ka raw message upar hai — usko SmartAPI docs/forum me dhoondo.');
    fail(msg, hints);
  }

  // -- 4. scrip master ------------------------------------------------------
  step(4, 'Scrip master download kar raha hoon (bada file hai, ruko)');
  let list;
  const tScrip = Date.now();
  try {
    list = await loadScrip();
    ok(`Scrip master mila: ${list.length.toLocaleString('en-IN')} instruments (${Date.now() - tScrip}ms)`);
  } catch (e) {
    fail('Scrip master fetch fail: ' + e.message, [
      'margincalculator.angelbroking.com blocked ho sakta hai — network check karo.',
    ]);
  }

  // -- 5. instrument lookup -------------------------------------------------
  step(5, `${SYMBOL} ke option instruments dhoondh raha hoon`);
  const isIndex = !!INDEX_TOKENS[SYMBOL];
  const optType = isIndex ? 'OPTIDX' : 'OPTSTK';
  const opts = list.filter(
    (r) => r.exch_seg === 'NFO' && r.instrumenttype === optType && (r.name || '').toUpperCase() === SYMBOL
  );
  if (!opts.length) {
    fail(`Scrip master me ${SYMBOL} ka koi ${optType} nahi mila`, [
      'Symbol ka naam Angel ke naming se match nahi kar raha.',
      'Stock hai to F&O me hona chahiye — cash-only stocks ke options nahi hote.',
    ]);
  }
  ok(`${opts.length} option contracts mile (type: ${optType}, ${isIndex ? 'INDEX' : 'STOCK'})`);

  const expMap = new Map();
  for (const o of opts) {
    const d = parseAngelExpiry(o.expiry);
    if (d && d.getTime() >= Date.now() - 86400000) expMap.set(fmtExpiry(d), d);
  }
  const expiries = [...expMap.keys()].sort((a, b) => expMap.get(a) - expMap.get(b));
  ok(`Aane wali ${expiries.length} expiries: ${expiries.slice(0, 5).join(', ')}`);

  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const nearest = expMap.get(expiries[0]);
  info(`Sabse nazdeek expiry ${expiries[0]} ek ${DAY[nearest.getDay()]} hai`);
  if (nearest.getDay() !== 2) {
    info('\x1b[33m⚠ NSE ka expiry ab Tuesday hai (1 Sep 2025 se). Ye Tuesday nahi hai — jaanch lo.\x1b[0m');
  }

  // -- 6. full chain fetch --------------------------------------------------
  step(6, `Live option chain fetch kar raha hoon (${SYMBOL})`);
  const tChain = Date.now();
  let chain;
  try {
    chain = await angel.fetchChain(SYMBOL);
  } catch (e) {
    fail('fetchChain fail: ' + e.message, [
      'Quote API rate-limit kar sakta hai — thoda ruk ke dobara try karo.',
      'Market band ho to bhi quotes aane chahiye (last traded values).',
    ]);
  }
  ok(`Chain mil gaya (${Date.now() - tChain}ms)`);
  info(`source=${chain.source} · spot=${chain.underlyingValue} · expiry=${chain.expiry} · strikes=${chain.rows.length}`);

  if (!chain.underlyingValue || chain.underlyingValue <= 0) {
    bad('Spot price 0/khaali hai — underlying token resolve nahi hua');
  }

  const withOI = chain.rows.filter((r) => (r.CE.openInterest || 0) + (r.PE.openInterest || 0) > 0).length;
  const withLTP = chain.rows.filter((r) => (r.CE.lastPrice || 0) + (r.PE.lastPrice || 0) > 0).length;
  const withIV = chain.rows.filter((r) => (r.CE.impliedVolatility || 0) > 0).length;
  info(`OI wale strikes: ${withOI}/${chain.rows.length} · LTP wale: ${withLTP} · IV solve hua: ${withIV}`);
  if (withOI === 0) bad('Kisi bhi strike pe OI nahi — quote response me OI field missing ho sakti hai');
  if (withLTP === 0) bad('Kisi bhi strike pe LTP nahi — quote response khaali hai');

  const atm = chain.rows.reduce((a, b) =>
    Math.abs(a.strikePrice - chain.underlyingValue) < Math.abs(b.strikePrice - chain.underlyingValue) ? a : b);
  console.log('\n  ATM strike ' + atm.strikePrice + ':');
  console.log(`    CE  LTP ${atm.CE.lastPrice}  OI ${atm.CE.openInterest}  chgOI ${atm.CE.changeinOpenInterest}  IV ${atm.CE.impliedVolatility}%`);
  console.log(`    PE  LTP ${atm.PE.lastPrice}  OI ${atm.PE.openInterest}  chgOI ${atm.PE.changeinOpenInterest}  IV ${atm.PE.impliedVolatility}%`);

  // -- 7. OI change caveat --------------------------------------------------
  step(7, 'OI-change (change in Open Interest) check');
  const anyChg = chain.rows.some((r) => (r.CE.changeinOpenInterest || 0) !== 0 || (r.PE.changeinOpenInterest || 0) !== 0);
  if (!anyChg) {
    info('Saare chgOI = 0 — pehle poll pe ye NORMAL hai.');
    info('Angel OI-change nahi deta; adapter do polls compare karta hai (in-memory prevOI).');
    info('Confirm karne ke liye ye script ~30s baad dobara chalao — tab non-zero aana chahiye.');
    info('\x1b[33m⚠ Vercel/serverless pe har request naya process hota hai, isliye wahan ye HAMESHA 0 rahega.\x1b[0m');
  } else {
    ok('chgOI non-zero hai — OI tracking chal raha hai (matlab ye pehla poll nahi tha)');
  }

  // -- 8. daily candles (DEMA) ---------------------------------------------
  step(8, 'Daily candles fetch kar raha hoon (DEMA levels ke liye)');
  const tDaily = Date.now();
  const closes = await angel.fetchDaily(SYMBOL);
  if (!closes || !closes.length) {
    bad('fetchDaily ne kuch nahi diya — DEMA mock series pe fallback karega');
    info('Historical API ka access alag hota hai aur strictly rate-limited hai.');
    info('DEMA support/resistance tab real nahi honge — dhyan rakho.');
  } else {
    ok(`${closes.length} daily closes mile (${Date.now() - tDaily}ms)`);
    info(`Aakhri 5 closes: ${closes.slice(-5).join(', ')}`);
    if (closes.length < 200) info('\x1b[33m⚠ 200 se kam candles — 200 DEMA reliable nahi hoga.\x1b[0m');
  }

  // -- summary --------------------------------------------------------------
  console.log('\n\x1b[1;32m═══ ALL CHECKS PASSED ═══\x1b[0m');
  console.log(`
  Credentials kaam kar rahe hain. Ab:

    node server.js
    http://localhost:3000/app.html   ->  "Mock" checkbox UNTICK karo

  Source badge \x1b[34m🔵 BROKER\x1b[0m dikhna chahiye.
  Market hours: Mon-Fri 09:15-15:30 IST (bahar snapshot freeze rehta hai).
`);
  process.exit(0);
})().catch((e) => {
  console.log('\n\x1b[31mUnexpected error:\x1b[0m ' + (e && e.stack || e));
  process.exit(1);
});
