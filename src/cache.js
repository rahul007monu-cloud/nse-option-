'use strict';

/**
 * cache.js — a tiny shared cache with a Redis (Upstash REST) backend and an
 * in-memory fallback.
 *
 * WHY: on Vercel every request is a fresh, short-lived process, so the Angel
 * adapter's module-level caches (JWT, scrip master, previous OI) reset
 * constantly — which means re-login on every call, a huge scrip-master
 * re-download, and changeinOpenInterest permanently 0. A shared cache fixes all
 * three: the login token, per-symbol instrument tokens and the last OI snapshot
 * survive across requests and function instances.
 *
 * Backend selection:
 *   - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN set -> Upstash REST.
 *     (Plain HTTPS + bearer token, so it works from serverless with no driver
 *     and zero dependencies.)
 *   - Otherwise -> a process-local Map, so local/self-host behaviour is
 *     unchanged and the app never hard-depends on Redis.
 *
 * Commands go through Upstash's POST endpoint with a JSON array body
 * (["SET","key","value","EX","120"]) which, unlike the path form, has no URL
 * length limit — needed for the per-symbol instrument blobs. All values are
 * JSON-serialised; every failure is swallowed and treated as a cache miss so a
 * Redis outage can never take the app down.
 */

const https = require('https');

const URL_BASE = process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const ENABLED = !!(URL_BASE && TOKEN);

// ---- in-memory fallback ----------------------------------------------------
const mem = new Map(); // key -> { v, exp }
function memGet(key) {
  const e = mem.get(key);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) { mem.delete(key); return null; }
  return e.v;
}
function memSet(key, value, ttlSec) {
  mem.set(key, { v: value, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
}

// ---- Upstash REST (POST + JSON array command) ------------------------------
function upstashCmd(args) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(URL_BASE); } catch (_) { return resolve(null); }
    const bodyStr = JSON.stringify(args);
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname && u.pathname !== '/' ? u.pathname : '/',
        headers: {
          Authorization: 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        timeout: Number(process.env.CACHE_TIMEOUT_MS || 2500),
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.write(bodyStr);
    req.end();
  });
}

// ---- public API (values are JSON) ------------------------------------------
async function get(key) {
  if (!ENABLED) return memGet(key);
  const r = await upstashCmd(['GET', key]);
  if (!r || r.result == null) return null;
  try { return JSON.parse(r.result); } catch (_) { return null; }
}

async function set(key, value, ttlSec) {
  if (!ENABLED) return memSet(key, value, ttlSec);
  const args = ['SET', key, JSON.stringify(value)];
  if (ttlSec) { args.push('EX', String(Math.floor(ttlSec))); }
  await upstashCmd(args);
}

async function del(key) {
  if (!ENABLED) { mem.delete(key); return; }
  await upstashCmd(['DEL', key]);
}

function status() {
  return { backend: ENABLED ? 'upstash' : 'memory', enabled: ENABLED };
}

module.exports = { get, set, del, status, ENABLED };
