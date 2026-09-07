'use strict';

/**
 * credentials.js — store & load broker credentials.
 *
 * Priority when reading:
 *   1. Environment variables  (best for Vercel — permanent, secure)
 *   2. A JSON file            (best for self-host — set via the Admin panel)
 *
 * On Vercel the filesystem is read-only except the temp dir, and instances are
 * ephemeral, so file-saved creds do NOT persist across cold starts there. The
 * Admin panel therefore also shows the exact ENV values to paste into Vercel.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ON_VERCEL = !!process.env.VERCEL;
const CRED_PATH = ON_VERCEL
  ? path.join(os.tmpdir(), 'nse-credentials.json')
  : path.join(__dirname, '..', 'data', 'credentials.json');

const FIELDS = ['apiKey', 'clientCode', 'mpin', 'totpSecret'];

function fromEnv() {
  const e = process.env;
  const c = {
    apiKey: e.SMARTAPI_KEY || '',
    clientCode: e.SMARTAPI_CLIENT || '',
    mpin: e.SMARTAPI_PIN || '',
    totpSecret: e.SMARTAPI_TOTP_SECRET || '',
  };
  return FIELDS.every((f) => c[f]) ? c : null;
}

function fromFile() {
  try {
    const raw = fs.readFileSync(CRED_PATH, 'utf8');
    const c = JSON.parse(raw);
    return FIELDS.every((f) => c[f]) ? c : null;
  } catch (_) {
    return null;
  }
}

/** Full credentials (env wins), or null if not fully configured. */
function getCredentials() {
  return fromEnv() || fromFile();
}

function saveCredentials(input) {
  const c = {};
  for (const f of FIELDS) c[f] = String((input && input[f]) || '').trim();
  const missing = FIELDS.filter((f) => !c[f]);
  if (missing.length) {
    return { ok: false, error: 'Missing: ' + missing.join(', ') };
  }
  c.broker = 'angelone';
  c.savedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(CRED_PATH), { recursive: true });
    fs.writeFileSync(CRED_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
    return { ok: true, path: CRED_PATH, ephemeral: ON_VERCEL };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function clearCredentials() {
  try { fs.unlinkSync(CRED_PATH); } catch (_) {}
  return { ok: true };
}

const maskVal = (v) => (!v ? '' : v.length <= 4 ? '••' : v.slice(0, 2) + '••••' + v.slice(-2));

/** Safe status for the UI — never returns raw secrets. */
function getStatus() {
  const env = fromEnv();
  const file = fromFile();
  const active = env || file;
  return {
    configured: !!active,
    source: env ? 'env' : file ? 'file' : 'none',
    onVercel: ON_VERCEL,
    masked: active
      ? {
          apiKey: maskVal(active.apiKey),
          clientCode: maskVal(active.clientCode),
          mpin: '••••',
          totpSecret: maskVal(active.totpSecret),
        }
      : null,
    savedAt: file ? file.savedAt : null,
  };
}

module.exports = { getCredentials, saveCredentials, clearCredentials, getStatus, CRED_PATH, ON_VERCEL };
