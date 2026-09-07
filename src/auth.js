'use strict';

/**
 * auth.js — zero-dependency authentication.
 *   • Passwords hashed with scrypt (Node crypto) + per-user salt.
 *   • Sessions are stateless HMAC-signed tokens: base64url(payload).signature
 *     stored in an httpOnly cookie. No server session store needed.
 */

const crypto = require('crypto');
const store = require('./store');
const { planHasFeature } = require('./plans');

const COOKIE = 'op_session';
const SESSION_DAYS = 30;

function secret() {
  // Prefer an explicit secret; else derive a stable-per-deploy fallback.
  return process.env.SESSION_SECRET || process.env.ADMIN_TOKEN || 'op-dev-secret-change-me';
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

function sign(payloadStr) {
  return crypto.createHmac('sha256', secret()).update(payloadStr).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function createToken(user) {
  const payload = { uid: user.id, role: user.role, exp: Date.now() + SESSION_DAYS * 86400000 };
  const p = b64url(JSON.stringify(payload));
  return p + '.' + sign(p);
}
function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [p, sig] = token.split('.');
  if (sign(p) !== sig) return null;
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
  return u || null;
}

// ---- signup / login --------------------------------------------------------
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')); }

function signup({ name, email, password }) {
  email = String(email || '').toLowerCase().trim();
  if (!validEmail(email)) return { ok: false, error: 'Valid email daalo' };
  if (!password || String(password).length < 6) return { ok: false, error: 'Password kam se kam 6 characters' };
  if (store.findUserByEmail(email)) return { ok: false, error: 'Ye email already registered hai' };

  const { salt, hash } = hashPassword(password);
  const isAdmin = process.env.ADMIN_EMAIL && email === process.env.ADMIN_EMAIL.toLowerCase();
  const firstUser = store.allUsers().length === 0;
  const user = {
    id: store.nextId(),
    name: String(name || '').trim() || email.split('@')[0],
    email,
    salt, hash,
    role: isAdmin || firstUser ? 'admin' : 'user', // first user bootstraps admin
    planId: 'free',
    planExpiry: null,
    createdAt: new Date().toISOString(),
  };
  store.addUser(user);
  return { ok: true, user, token: createToken(user) };
}

function login({ email, password }) {
  email = String(email || '').toLowerCase().trim();
  const u = store.findUserByEmail(email);
  if (!u || !verifyPassword(password, u.salt, u.hash)) {
    return { ok: false, error: 'Email ya password galat' };
  }
  return { ok: true, user: u, token: createToken(u) };
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
  COOKIE, hashPassword, verifyPassword,
  createToken, verifyToken, parseCookies, sessionCookie, clearCookie,
  currentUser, signup, login, publicUser, userHasFeature,
};
