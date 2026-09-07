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
const { runScan } = require('./scanner');
const cred = require('./credentials');
const store = require('./store');
const auth = require('./auth');
const { loadBroker, reloadBroker, brokerStatus } = require('./brokers/loader');

// Wire a broker adapter if configured (Angel One creds or BROKER_MODULE).
loadBroker();

// ---- Admin (credential management) -----------------------------------------
function isLocalHost(host) {
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/.test(String(host || ''));
}
/**
 * Secure-by-default admin gate:
 *  - ADMIN_TOKEN set  -> must match (password login), from anywhere
 *  - no token + localhost -> allowed (only reachable by you on your device)
 *  - no token + public host -> LOCKED (prevents open admin on Vercel)
 */
function adminAuthOK(token, host) {
  const need = process.env.ADMIN_TOKEN;
  if (need) return token === need;
  return isLocalHost(host);
}
function adminLockReason(host) {
  if (process.env.ADMIN_TOKEN) return 'Galat ya missing password.';
  if (!isLocalHost(host)) return 'Admin locked. Public URL pe admin chalane ke liye Vercel me ADMIN_TOKEN env var set karo (wahi password hoga), phir redeploy.';
  return 'Locked.';
}
function getAdminStatus() {
  return { ...cred.getStatus(), broker: brokerStatus(), adminProtected: !!process.env.ADMIN_TOKEN };
}
function saveAdminCreds(body) {
  const r = cred.saveCredentials(body || {});
  if (r.ok) { try { reloadBroker(); } catch (_) {} }
  return r;
}
function clearAdminCreds() {
  const r = cred.clearCredentials();
  try { reloadBroker(); } catch (_) {}
  return r;
}
async function testBroker() {
  try {
    if (!cred.getCredentials()) return { ok: false, error: 'Credentials not configured yet' };
    reloadBroker();
    const angel = require('../brokers/angelone.js');
    const chain = await angel.fetchChain('NIFTY');
    return { ok: true, source: chain.source, spot: chain.underlyingValue, strikes: chain.rows.length, expiry: chain.expiry };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
}

// ---- Scanner with a short TTL cache (scanning ~300 symbols is not free) -----
let scanCache = { at: 0, data: null, key: '' };
const SCAN_TTL_MS = Number(process.env.SCAN_TTL_MS || 60000); // 60s
async function getScan(opts = {}) {
  const preferMock = !!opts.mock || process.env.PREFER_MOCK === '1';
  const key = preferMock ? 'mock' : 'live';
  const now = Date.now();
  if (scanCache.data && scanCache.key === key && now - scanCache.at < SCAN_TTL_MS) {
    return { ...scanCache.data, cached: true };
  }
  const data = await runScan({ preferMock });
  scanCache = { at: now, data, key };
  return { ...data, cached: false };
}

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
  // Force mock either per-request (?mock=1) or globally via env (useful on hosts
  // like Vercel where NSE blocks the datacenter IP — set PREFER_MOCK=1 there).
  const preferMock = !!q.mock || process.env.PREFER_MOCK === '1';
  const expiryIndex = Number.isFinite(q.expiryIndex) ? q.expiryIndex : 0;

  const [chain, daily] = await Promise.all([
    nse.getOptionChain(symbol, { preferMock, expiryIndex }),
    nse.getDailyHistory(symbol, { preferMock }),
  ]);
  return analyze(chain, { daily });
}

// ---- Auth --------------------------------------------------------------------
function doSignup(body) {
  const r = auth.signup(body || {});
  if (!r.ok) return r;
  return { ok: true, user: auth.publicUser(r.user), token: r.token };
}
function doLogin(body) {
  const r = auth.login(body || {});
  if (!r.ok) return r;
  return { ok: true, user: auth.publicUser(r.user), token: r.token };
}
function meFromReq(req) {
  const u = auth.currentUser(req);
  return { user: auth.publicUser(u) };
}

// ---- Plans (public) ----------------------------------------------------------
function getPublicPlans() {
  return { plans: store.allPlans().filter((p) => p.active !== false).sort((a, b) => (a.order || 0) - (b.order || 0)) };
}

// ---- Platform admin (users / plans / subscriptions) --------------------------
function isPlatformAdmin(req, token, host) {
  const u = auth.currentUser(req);
  if (u && u.role === 'admin') return true;
  return adminAuthOK(token, host); // fallback: ADMIN_TOKEN / localhost
}
function adminListUsers() {
  return { users: store.allUsers().map((u) => auth.publicUser(u)) };
}
function adminSetUserPlan(body) {
  const { userId, planId, days } = body || {};
  if (!store.findPlan(planId)) return { ok: false, error: 'Unknown plan' };
  const expiry = days ? new Date(Date.now() + Number(days) * 86400000).toISOString() : null;
  const u = store.updateUser(userId, { planId, planExpiry: expiry });
  return u ? { ok: true, user: auth.publicUser(u) } : { ok: false, error: 'User not found' };
}
function adminDeleteUser(body) {
  return { ok: store.deleteUser((body || {}).userId) };
}
function adminUpsertPlan(body) {
  if (!body || !body.id || !body.name) return { ok: false, error: 'id and name required' };
  const plan = {
    id: String(body.id).toLowerCase(), name: body.name,
    price: Number(body.price) || 0, currency: body.currency || 'INR',
    period: body.period || 'month', tagline: body.tagline || '',
    features: Array.isArray(body.features) ? body.features : String(body.features || '').split(',').map((s) => s.trim()).filter(Boolean),
    highlights: Array.isArray(body.highlights) ? body.highlights : String(body.highlights || '').split('\n').map((s) => s.trim()).filter(Boolean),
    active: body.active !== false, order: Number(body.order) || 99,
  };
  store.upsertPlan(plan);
  return { ok: true, plan };
}
function adminDeletePlan(body) {
  return { ok: store.deletePlan((body || {}).id) };
}

module.exports = {
  getHealth, getSymbols, getAnalysis, getScan,
  adminAuthOK, adminLockReason, getAdminStatus, saveAdminCreds, clearAdminCreds, testBroker,
  // auth
  doSignup, doLogin, meFromReq,
  // plans
  getPublicPlans,
  // platform admin
  isPlatformAdmin, adminListUsers, adminSetUserPlan, adminDeleteUser, adminUpsertPlan, adminDeletePlan,
};
