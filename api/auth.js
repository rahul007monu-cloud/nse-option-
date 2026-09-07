'use strict';

// Vercel serverless -> /api/auth/:action (signup | login | logout | me)
const service = require('../src/service');
const auth = require('../src/auth');

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function send(res, status, obj, cookie) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.statusCode = status;
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  const action = (req.url.split('?')[0].split('/').pop() || '').toLowerCase();
  try {
    if (action === 'signup') {
      const r = service.doSignup(await readBody(req));
      if (!r.ok) return send(res, 400, r);
      return send(res, 200, { ok: true, user: r.user }, auth.sessionCookie(r.token));
    }
    if (action === 'login') {
      const r = service.doLogin(await readBody(req));
      if (!r.ok) return send(res, 401, r);
      return send(res, 200, { ok: true, user: r.user }, auth.sessionCookie(r.token));
    }
    if (action === 'logout') return send(res, 200, { ok: true }, auth.clearCookie());
    if (action === 'me') return send(res, 200, service.meFromReq(req));
    return send(res, 404, { error: 'Unknown auth action' });
  } catch (e) {
    return send(res, 500, { error: String(e && e.message) });
  }
};
