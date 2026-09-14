'use strict';

/**
 * http.js — tiny request/response helpers shared by the Vercel serverless
 * handlers in api/*.js.
 *
 * These were copy-pasted into three separate handlers before, which is how the
 * `action` parsing in api/admin.js and api/auth.js drifted apart. One copy now.
 *
 * Lives in src/ (not api/) on purpose: everything inside api/ is treated as a
 * deployable function by Vercel, and this is a library, not an endpoint.
 */

/** Parsed query string, whether or not the platform pre-populates req.query. */
function query(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try {
    return Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  } catch (_) {
    return {};
  }
}

/**
 * The action for a multiplexed endpoint such as /api/auth/login.
 *
 * Reads ?action= first, then falls back to the last path segment. Both are
 * needed: vercel.json rewrites the path to the bare function and passes the
 * action as a query param, while server.js keeps the original nested path
 * locally. Checking both means the two targets can't diverge again.
 */
function action(req, fallbackNames) {
  const q = query(req);
  if (q.action) return String(q.action).toLowerCase();
  const seg = String(req.url || '').split('?')[0].split('/').filter(Boolean).pop() || '';
  // Guard against returning the function's own name ("auth"/"admin") as an action.
  if (fallbackNames && fallbackNames.includes(seg.toLowerCase())) return '';
  return seg.toLowerCase();
}

/** Read and JSON-parse a request body, tolerating pre-parsed req.body. */
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/** JSON response. `cookie` sets Set-Cookie when provided. */
function send(res, status, obj, cookie) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.statusCode = status;
  res.end(JSON.stringify(obj));
}

/** Send an authorize() rejection using the status it carried. */
function sendDenied(res, gate) {
  return send(res, gate.status || 401, {
    error: gate.error,
    needsFeature: gate.needsFeature,
    planId: gate.planId,
  });
}

module.exports = { query, action, readBody, send, sendDenied };
