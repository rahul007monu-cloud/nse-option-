'use strict';

/**
 * auth.js — zero-dependency authentication.
 *   • Passwords hashed with scrypt (Node crypto) + per-user salt.
 *   • Sessions are stateless HMAC-signed tokens: base64url(payload).signature
 *     stored in an httpOnly cookie. No server session store needed.
 */

const crypto = require('crypto');
const store = require('./store');

const COOKIE = 'op_session';
const SESSION_DAYS = 30;
const MIN_SECRET_LEN = 32;

const IS_PRODUCTION = !!process.env.VERCEL || process.env.NODE_ENV === 'production';

const CONFIG_ERROR =
  'Server misconfigured: SESSION_SECRET set nahi hai. Deploy me ye env var daalo (openssl rand -hex 48).';

let devSecret = null;
let devWarned = false;

/**
 * HMAC key for session tokens.
 *
 * There is deliberately NO hardcoded fallback. This file is public, so a
 * baked-in default would let anyone forge an admin session by signing their
 * own cookie. Returns null when no usable secret exists; every caller then
 * fails closed (nobody is logged in, and no token can be minted).
 */
function secret() {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= MIN_SECRET_LEN) return fromEnv;

  if (fromEnv) {
    console.error(
      `[auth] SESSION_SECRET is only ${fromEnv.length} chars, needs >= ${MIN_SECRET_LEN}. Refusing to use it.`
    );
    return null;
  }
  if (IS_PRODUCTION) {
    console.error('[auth] SESSION_SECRET is not set — logins are disabled. Generate one: openssl rand -hex 48');
    return null;
  }
  // Local dev only: a random per-process secret. Sessions die on restart,
  // which is the safe default. Set SESSION_SECRET to make them persist.
  if (!devSecret) devSecret = crypto.randomBytes(48).toString('hex');
  if (!devWarned) {
    devWarned = true;
    console.warn('[auth] SESSION_SECRET not set — using a random dev secret. Sessions reset on restart.');
  }
  return devSecret;
}

/** Can sessions be signed/verified right now? Lets the API return a clear error. */
function authConfigured() {
  return secret() !== null;
}

/** Emails allowed to become admin on signup (comma-separated ADMIN_EMAIL). */
function adminEmails() {
  return String(process.env.ADMIN_EMAIL || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- password hashing ------------------------------------------------------
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- session tokens --------------------------------------------------------
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

/** HMAC signature, or null when no secret is configured. */
function sign(payloadStr) {
  const key = secret();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(payloadStr).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** Mint a session token, or null when auth is not configured. */
function createToken(user) {
  // Everything needed to rebuild the session lives in the (signed) token, so a
  // login survives the store being wiped on a serverless cold start. This is
  // what makes the session truly stateless — the store is only a convenience
  // for admin user-management, not the source of truth for "am I logged in".
  const payload = {
    uid: user.id,
    role: user.role,
    email: user.email,
    plan: user.planId || 'free',
    exp: Date.now() + SESSION_DAYS * 86400000,
  };
  const p = b64url(JSON.stringify(payload));
  const sig = sign(p);
  return sig ? p + '.' + sig : null;
}
function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [p, sig] = token.split('.');
  const expected = sign(p);
  if (!expected || !sig) return null;
  // Constant-time compare so signature checks can't be timing-probed.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(p));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

// ---- cookies ---------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  const raw = req.headers && req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function sessionCookie(token) {
  const maxAge = SESSION_DAYS * 86400;
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ---- current user from request ---------------------------------------------
function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  const payload = verifyToken(token);
  if (!payload) return null;
  const u = store.findUserById(payload.uid);
  if (u) return u;
  // Store miss (Vercel /tmp reset on cold start). The token is HMAC-signed, so
  // rebuild the session from it instead of logging the user out. This is why
  // sessions no longer drop every cold start.
  if (!payload.email) return null;
  const email = String(payload.email).toLowerCase();
  // Allowlisted email is always an admin, even if the token was minted before
  // ADMIN_EMAIL was configured.
  const role = adminEmails().includes(email) ? 'admin' : (payload.role || 'user');
  return {
    id: payload.uid,
    email: payload.email,
    name: payload.email.split('@')[0],
    role,
    planId: role === 'admin' ? 'premium' : (payload.plan || 'free'),
    planExpiry: null,
  };
}

// ---- signup / login --------------------------------------------------------
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')); }

function signup({ name, email, password }) {
  if (!authConfigured()) return { ok: false, error: CONFIG_ERROR };
  email = String(email || '').toLowerCase().trim();
  if (!validEmail(email)) return { ok: false, error: 'Valid email daalo' };
  if (!password || String(password).length < 8) return { ok: false, error: 'Password kam se kam 8 characters' };
  if (store.findUserByEmail(email)) return { ok: false, error: 'Ye email already registered hai' };

  const { salt, hash } = hashPassword(password);
  // Admin is granted ONLY by the ADMIN_EMAIL allowlist. There is deliberately
  // no "first user becomes admin" bootstrap: on an ephemeral store (Vercel /tmp)
  // that resets every cold start, so whoever signed up next became admin.
  const user = {
    id: store.nextId(),
    name: String(name || '').trim() || email.split('@')[0],
    email,
    salt, hash,
    role: adminEmails().includes(email) ? 'admin' : 'user',
    planId: 'free',
    planExpiry: null,
    createdAt: new Date().toISOString(),
  };
  store.addUser(user);
  const token = createToken(user);
  if (!token) return { ok: false, error: CONFIG_ERROR };
  return { ok: true, user, token };
}

function login({ email, password }) {
  if (!authConfigured()) return { ok: false, error: CONFIG_ERROR };
  email = String(email || '').toLowerCase().trim();
  const u = store.findUserByEmail(email);
  if (!u || !verifyPassword(password, u.salt, u.hash)) {
    return { ok: false, error: 'Email ya password galat' };
  }
  const token = createToken(u);
  if (!token) return { ok: false, error: CONFIG_ERROR };
  return { ok: true, user: u, token };
}

// ---- public projection + entitlements --------------------------------------
function publicUser(u) {
  if (!u) return null;
  const plan = store.findPlan(u.planId) || store.findPlan('free');
  const expired = u.planExpiry && new Date(u.planExpiry).getTime() < Date.now();
  const effectivePlan = expired ? store.findPlan('free') : plan;
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    planId: effectivePlan ? effectivePlan.id : 'free',
    planName: effectivePlan ? effectivePlan.name : 'Free',
    planExpiry: u.planExpiry || null,
    features: effectivePlan ? effectivePlan.features : [],
  };
}

function userHasFeature(u, feature) {
  const pu = publicUser(u);
  return !!(pu && pu.features.includes(feature));
}

module.exports = {
  COOKIE, CONFIG_ERROR, hashPassword, verifyPassword,
  createToken, verifyToken, parseCookies, sessionCookie, clearCookie,
  currentUser, signup, login, publicUser, userHasFeature,
  authConfigured, adminEmails,
};
