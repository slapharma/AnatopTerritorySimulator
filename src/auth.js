'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scryptAsync = promisify(crypto.scrypt);
const db = require('./db');

async function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptAsync(plain, salt, 64)).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

async function verifyPassword(plain, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, hashHex] = stored.split('$');
  const hash = await scryptAsync(plain, salt, 64);
  const storedBuf = Buffer.from(hashHex, 'hex');
  if (storedBuf.length !== hash.length) return false;
  return crypto.timingSafeEqual(hash, storedBuf);
}

// One-time migration from the old env-var allowlist (AUTH_USERS/AUTH_PASSWORD)
// into the users table, so existing credentials keep working with no manual
// step. Runs at most once per process (cached promise), only if the table is
// still empty by the time it's checked.
let seedPromise = null;
function ensureSeeded() {
  if (!seedPromise) {
    seedPromise = (async () => {
      if ((await db.countUsers()) > 0) return;
      const usersEnv = process.env.AUTH_USERS || '';
      const password = process.env.AUTH_PASSWORD || '';
      const emails = usersEnv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!emails.length || !password) return; // nothing to seed; dev bypass applies
      const password_hash = await hashPassword(password);
      for (let i = 0; i < emails.length; i++) {
        await db.createUser({ email: emails[i], password_hash, is_admin: i === 0 });
      }
    })();
  }
  return seedPromise;
}

async function basicAuth(req, res, next) {
  try {
    await ensureSeeded();
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [emailRaw, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
      const email = String(emailRaw || '').trim().toLowerCase();
      const user = await db.getUserByEmail(email);
      if (user && pass && (await verifyPassword(pass, user.password_hash))) {
        req.user = { id: user.id, email: user.email, is_admin: user.is_admin };
        return next();
      }
    }
    if ((await db.countUsers()) === 0) return next(); // no users configured at all (local dev)
  } catch (e) {
    console.error('auth error:', e.message); // fail closed on any DB/hash error
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Anatop Territory Evaluation", charset="UTF-8"');
  res.status(401).send('Authentication required.');
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.is_admin) return next();
  res.status(403).json({ error: 'Admin access required' });
}

module.exports = { basicAuth, requireAdmin, hashPassword, verifyPassword };
