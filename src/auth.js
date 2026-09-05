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
    })().catch((e) => {
      // A rejected promise stays cached forever otherwise — one transient DB
      // error while seeding would pin every request to the catch-and-401
      // branch below for the rest of the process's life. Clear the cache so
      // the next request retries instead of replaying the same failure.
      seedPromise = null;
      throw e;
    });
  }
  return seedPromise;
}

// True local dev only: never silently open a real deployment just because
// nobody has created a user row yet (unset/misconfigured AUTH_USERS on Vercel,
// or seeding having failed, would otherwise leave the whole app unauthenticated).
async function noAuthConfigured() {
  return !process.env.VERCEL && (await db.countUsers()) === 0;
}

// Best-effort brute-force throttle, keyed by IP. In-memory, so it resets on
// cold start and doesn't share state across Vercel lambda instances — not
// airtight on serverless, but still meaningfully raises the cost of hammering
// login with guesses, and scrypt itself is CPU-heavy enough that unthrottled
// attempts are also a cheap DoS against the server.
const failedAttempts = new Map();
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 5 * 60 * 1000;
function isLockedOut(key) {
  const rec = failedAttempts.get(key);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) { failedAttempts.delete(key); return false; }
  return rec.count >= MAX_ATTEMPTS;
}
function recordFailure(key) {
  const rec = failedAttempts.get(key) || { count: 0, resetAt: Date.now() + LOCKOUT_MS };
  rec.count++;
  failedAttempts.set(key, rec);
}
function recordSuccess(key) { failedAttempts.delete(key); }

async function basicAuth(req, res, next) {
  try {
    await ensureSeeded();
    if (isLockedOut(req.ip)) return res.status(429).json({ error: 'Too many failed login attempts. Try again in a few minutes.' });
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [emailRaw, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
      const email = String(emailRaw || '').trim().toLowerCase();
      const user = await db.getUserByEmail(email);
      if (user && pass && (await verifyPassword(pass, user.password_hash))) {
        recordSuccess(req.ip);
        req.user = { id: user.id, email: user.email, is_admin: user.is_admin };
        return next();
      }
      if (scheme === 'Basic') recordFailure(req.ip);
    }
    if (await noAuthConfigured()) return next();
  } catch (e) {
    console.error('auth error:', e.message); // fail closed on any DB/hash error
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Anatop Territory Evaluation", charset="UTF-8"');
  res.status(401).send('Authentication required.');
}

async function requireAdmin(req, res, next) {
  if (req.user && req.user.is_admin) return next();
  // Consistent with basicAuth's own bypass: no users configured at all means
  // no auth is enforced anywhere (local dev), so an admin-only route should
  // not be the one place that still 403s.
  if (await noAuthConfigured()) return next();
  res.status(403).json({ error: 'Admin access required' });
}

module.exports = { basicAuth, requireAdmin, hashPassword, verifyPassword };
