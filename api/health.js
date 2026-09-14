'use strict';

// Vercel serverless function -> GET /api/health
const { getHealth } = require('../src/service');
const { send } = require('../src/http');

module.exports = async (req, res) => send(res, 200, await getHealth());
