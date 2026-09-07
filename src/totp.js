'use strict';

/**
 * totp.js — RFC 6238 TOTP generator (zero-dependency, uses Node crypto).
 *
 * Angel One SmartAPI login needs a 6-digit TOTP. Instead of an authenticator
 * app running somewhere, the server generates the code itself from the base32
 * SECRET you saved when enabling TOTP. So no SMS, no app, fully automated.
 */

const crypto = require('crypto');

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input || '').replace(/=+$/,'').replace(/\s+/g, '').toUpperCase();
  let bits = '';
  for (const ch of clean) {
    const val = alphabet.indexOf(ch);
    if (val < 0) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * @param {string} secret base32 secret
 * @param {object} [opts] { digits=6, period=30, timestamp=Date.now(), algorithm='sha1' }
 * @returns {string} zero-padded code
 */
function totp(secret, opts = {}) {
  const digits = opts.digits || 6;
  const period = opts.period || 30;
  const t = opts.timestamp || Date.now();
  const algorithm = opts.algorithm || 'sha1';

  const key = base32Decode(secret);
  let counter = Math.floor(t / 1000 / period);

  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }

  const hmac = crypto.createHmac(algorithm, key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % Math.pow(10, digits)).padStart(digits, '0');
}

module.exports = { totp, base32Decode };
