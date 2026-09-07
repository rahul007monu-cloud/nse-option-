'use strict';

/**
 * store.js — tiny persistent JSON store for users, plans, subscriptions, settings.
 *
 * Self-host (PC/Termux): saved to data/store.json (gitignored) -> persists.
 * Vercel: saved to /tmp (ephemeral) -> resets on cold start. For persistent
 * multi-user accounts on Vercel, wire a hosted DB/KV (Upstash/Neon) later; this
 * module is the single seam where that swap would happen.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultPlans } = require('./plans');

const ON_VERCEL = !!process.env.VERCEL;
const STORE_PATH = ON_VERCEL
  ? path.join(os.tmpdir(), 'nse-store.json')
  : path.join(__dirname, '..', 'data', 'store.json');

let cache = null;

function freshDb() {
  return {
    users: [],
    plans: defaultPlans(),
    settings: { siteName: 'OptionPulse', createdAt: new Date().toISOString() },
    seq: 1,
  };
}

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (!cache.users) cache.users = [];
    if (!cache.plans || !cache.plans.length) cache.plans = defaultPlans();
    if (!cache.settings) cache.settings = { siteName: 'OptionPulse' };
    if (!cache.seq) cache.seq = (cache.users.length || 0) + 1;
  } catch (_) {
    cache = freshDb();
    save();
  }
  return cache;
}

function save() {
  if (!cache) return;
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (e) {
    // On read-only FS this may fail; keep working from memory.
    console.warn('[store] save failed: ' + e.message);
  }
}

function nextId() {
  const db = load();
  const id = db.seq++;
  save();
  return id;
}

// ---- Users -----------------------------------------------------------------
function findUserByEmail(email) {
  const db = load();
  const e = String(email || '').toLowerCase().trim();
  return db.users.find((u) => u.email === e) || null;
}
function findUserById(id) {
  const db = load();
  return db.users.find((u) => u.id === Number(id)) || null;
}
function addUser(user) {
  const db = load();
  db.users.push(user);
  save();
  return user;
}
function updateUser(id, patch) {
  const db = load();
  const u = db.users.find((x) => x.id === Number(id));
  if (!u) return null;
  Object.assign(u, patch);
  save();
  return u;
}
function deleteUser(id) {
  const db = load();
  const i = db.users.findIndex((x) => x.id === Number(id));
  if (i < 0) return false;
  db.users.splice(i, 1);
  save();
  return true;
}
function allUsers() {
  return load().users;
}

// ---- Plans -----------------------------------------------------------------
function allPlans() {
  return load().plans;
}
function findPlan(id) {
  return load().plans.find((p) => p.id === id) || null;
}
function upsertPlan(plan) {
  const db = load();
  const i = db.plans.findIndex((p) => p.id === plan.id);
  if (i >= 0) db.plans[i] = { ...db.plans[i], ...plan };
  else db.plans.push(plan);
  save();
  return plan;
}
function deletePlan(id) {
  const db = load();
  const i = db.plans.findIndex((p) => p.id === id);
  if (i < 0) return false;
  db.plans.splice(i, 1);
  save();
  return true;
}

// ---- Settings --------------------------------------------------------------
function getSettings() { return load().settings; }
function setSettings(patch) { const db = load(); Object.assign(db.settings, patch); save(); return db.settings; }

module.exports = {
  STORE_PATH, ON_VERCEL,
  load, save, nextId,
  findUserByEmail, findUserById, addUser, updateUser, deleteUser, allUsers,
  allPlans, findPlan, upsertPlan, deletePlan,
  getSettings, setSettings,
};
