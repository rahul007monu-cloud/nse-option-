'use strict';

// Vercel serverless -> /api/admin/:action  (status | save | test | clear | users | ...)
//
// The action arrives as ?action= via the rewrite in vercel.json; the path
// fallback keeps server.js working locally.
//
// The admin password is read from the x-admin-token header only. Accepting it as
// a ?token= query param was dropped: query strings end up in access logs,
// browser history and Referer headers.
const service = require('../src/service');
const { action, readBody, send } = require('../src/http');

// Actions that change state must be POST, matching server.js.
const MUTATIONS = new Set(['save', 'clear', 'test', 'user-plan', 'user-delete', 'plan-save', 'plan-delete']);

module.exports = async (req, res) => {
  const token = req.headers['x-admin-token'] || '';
  if (!service.isPlatformAdmin(req, token, req.headers.host)) {
    return send(res, 401, { error: 'Admin locked', reason: service.adminLockReason(req.headers.host) });
  }

  const what = action(req, ['admin']);
  if (MUTATIONS.has(what) && req.method !== 'POST') {
    return send(res, 405, { error: 'POST only: ' + what });
  }

  try {
    if (what === 'status') return send(res, 200, service.getAdminStatus());
    if (what === 'save') return send(res, 200, service.saveAdminCreds(await readBody(req)));
    if (what === 'clear') return send(res, 200, service.clearAdminCreds());
    if (what === 'test') return send(res, 200, await service.testBroker());
    if (what === 'users') return send(res, 200, service.adminListUsers());
    if (what === 'user-plan') return send(res, 200, service.adminSetUserPlan(await readBody(req)));
    if (what === 'user-delete') return send(res, 200, service.adminDeleteUser(await readBody(req)));
    if (what === 'plan-save') return send(res, 200, service.adminUpsertPlan(await readBody(req)));
    if (what === 'plan-delete') return send(res, 200, service.adminDeletePlan(await readBody(req)));
    return send(res, 404, { error: 'Unknown admin action: ' + (what || '(none)') });
  } catch (e) {
    return send(res, 500, { error: String(e && e.message) });
  }
};
