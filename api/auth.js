'use strict';

// Vercel serverless -> /api/auth/:action  (signup | login | logout | me)
//
// The action arrives as ?action= via the rewrite in vercel.json. Previously the
// handler only read the last path segment, which after the rewrite is "auth" —
// so every auth call 404'd in production while working fine locally.
const service = require('../src/service');
const auth = require('../src/auth');
const { action, readBody, send } = require('../src/http');

module.exports = async (req, res) => {
  const what = action(req, ['auth']);
  try {
    if (what === 'signup') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const r = service.doSignup(await readBody(req));
      if (!r.ok) return send(res, 400, r);
      return send(res, 200, { ok: true, user: r.user }, auth.sessionCookie(r.token));
    }
    if (what === 'login') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const r = service.doLogin(await readBody(req));
      if (!r.ok) return send(res, 401, r);
      return send(res, 200, { ok: true, user: r.user }, auth.sessionCookie(r.token));
    }
    if (what === 'logout') return send(res, 200, { ok: true }, auth.clearCookie());
    if (what === 'me') return send(res, 200, service.meFromReq(req));
    return send(res, 404, { error: 'Unknown auth action: ' + (what || '(none)') });
  } catch (e) {
    return send(res, 500, { error: String(e && e.message) });
  }
};
