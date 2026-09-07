'use strict';

// Vercel serverless -> /api/admin/:action  (status | save | test | clear)
const service = require('../src/service');

function query(req) {
  if (req.query) return req.query;
  try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch (_) { return {}; }
}
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function send(res, status, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  const q = query(req);
  const token = req.headers['x-admin-token'] || q.token || '';
  if (!service.isPlatformAdmin(req, token, req.headers.host)) {
    return send(res, 401, { error: 'Admin locked', reason: service.adminLockReason(req.headers.host) });
  }

  // action from ?action= or trailing path segment
  const action = q.action || (req.url.split('?')[0].split('/').pop());

  try {
    if (action === 'status') return send(res, 200, service.getAdminStatus());
    if (action === 'save') return send(res, 200, service.saveAdminCreds(await readBody(req)));
    if (action === 'clear') return send(res, 200, service.clearAdminCreds());
    if (action === 'test') return send(res, 200, await service.testBroker());
    if (action === 'users') return send(res, 200, service.adminListUsers());
    if (action === 'user-plan') return send(res, 200, service.adminSetUserPlan(await readBody(req)));
    if (action === 'user-delete') return send(res, 200, service.adminDeleteUser(await readBody(req)));
    if (action === 'plan-save') return send(res, 200, service.adminUpsertPlan(await readBody(req)));
    if (action === 'plan-delete') return send(res, 200, service.adminDeletePlan(await readBody(req)));
    return send(res, 404, { error: 'Unknown admin action: ' + action });
  } catch (e) {
    return send(res, 500, { error: String(e && e.message) });
  }
};
