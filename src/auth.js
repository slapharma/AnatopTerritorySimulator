'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scryptAsync = promisify(crypto.scrypt);
const db = require('./db');

const COOKIE_NAME = 'anatop_session';
const SESSION_MS = 12 * 60 * 60 * 1000; // 12 hours

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

// ---------------------------------------------------------------- sessions
//
// The signing key for session cookies. AUTH_SECRET is the supported way to set
// it. Without it:
//
//  * off Vercel, a random key is generated per process. Sessions then die with
//    the process, which is fine for local development and is announced.
//  * on Vercel, form login is switched OFF rather than run on a per-instance
//    key. Each lambda would sign with a different key, so a cookie minted by
//    one instance would be rejected by the next and users would appear to be
//    randomly signed out. Basic auth still works, so the app is reachable —
//    this fails safe, never open.
let devSecret = null;
function sessionSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  if (process.env.VERCEL) return null;
  if (!devSecret) {
    devSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[auth] AUTH_SECRET is not set: signing sessions with a per-process key, so everyone is signed out when the server restarts. Set AUTH_SECRET to make sessions durable.');
  }
  return devSecret;
}
function formLoginAvailable() { return Boolean(sessionSecret()); }

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function mintSession(user) {
  const secret = sessionSecret();
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify({ uid: user.id, exp: Date.now() + SESSION_MS })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

// Returns the user id carried by a valid, unexpired token, or null. The HMAC is
// compared with timingSafeEqual: a plain === leaks how much of the signature
// matched, which is enough to forge one a byte at a time.
function readSession(token) {
  const secret = sessionSecret();
  if (!secret || !token || typeof token !== 'string') return null;
  const [payloadB64, mac] = token.split('.');
  if (!payloadB64 || !mac) return null;
  const expected = sign(payloadB64, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!uid || !exp || Date.now() > exp) return null;
    return uid;
  } catch { return null; }
}

// Secure is set whenever the request arrived over https, which covers Vercel
// (x-forwarded-proto) without breaking plain-http local development, where a
// Secure cookie would simply never be stored.
function cookieOptions(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0] || req.protocol;
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: proto === 'https',
    path: '/',
    maxAge: Math.floor(SESSION_MS / 1000),
  };
}
// express ships res.cookie(); reading is a four-line parse, so the cookie
// package stays an express implementation detail rather than a dependency of
// ours that package.json does not declare.
function setSessionCookie(req, res, token) {
  res.cookie(COOKIE_NAME, token, cookieOptions(req));
}
function clearSessionCookie(req, res) {
  res.cookie(COOKIE_NAME, '', { ...cookieOptions(req), maxAge: 0 });
}
function readCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
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

// Shared by the login route and the middleware. Returns the user row or null,
// and counts a failure against the caller's IP so both paths are throttled.
async function checkCredentials(ip, emailRaw, password) {
  const email = String(emailRaw || '').trim().toLowerCase();
  const user = await db.getUserByEmail(email);
  if (user && password && (await verifyPassword(password, user.password_hash))) {
    recordSuccess(ip);
    return user;
  }
  recordFailure(ip);
  return null;
}

// Cookie first, then Basic. Basic is kept because scripts, curl and the export
// endpoints rely on it, but no WWW-Authenticate header is sent any more: that
// header is what makes the browser throw up its own grey credential dialog
// instead of the sign-in page.
async function authenticate(req, res, next) {
  try {
    await ensureSeeded();
    if (isLockedOut(req.ip)) return res.status(429).json({ error: 'Too many failed login attempts. Try again in a few minutes.' });

    const cookies = readCookies(req.headers.cookie);
    const uid = readSession(cookies[COOKIE_NAME]);
    if (uid) {
      const user = await db.getUserById(uid);
      if (user) {
        req.user = { id: user.id, email: user.email, is_admin: user.is_admin };
        return next();
      }
    }

    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [emailRaw, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
      const user = await checkCredentials(req.ip, emailRaw, pass);
      if (user) {
        req.user = { id: user.id, email: user.email, is_admin: user.is_admin };
        return next();
      }
    }

    if (await noAuthConfigured()) return next();
  } catch (e) {
    console.error('auth error:', e.message); // fail closed on any DB/hash error
  }

  // A browser navigating to a page gets the sign-in page; anything else gets
  // JSON it can act on. Deciding on Accept rather than on the path keeps
  // fetch() calls from the app itself out of the redirect branch.
  const wantsHtml = String(req.headers.accept || '').includes('text/html');
  if (wantsHtml && req.method === 'GET') {
    const next_ = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(302, `/login?next=${next_}`);
  }
  res.status(401).json({ error: 'Not signed in.' });
}

async function requireAdmin(req, res, next) {
  if (req.user && req.user.is_admin) return next();
  // Consistent with authenticate's own bypass: no users configured at all means
  // no auth is enforced anywhere (local dev), so an admin-only route should
  // not be the one place that still 403s.
  if (await noAuthConfigured()) return next();
  res.status(403).json({ error: 'Admin access required' });
}

module.exports = {
  authenticate,
  basicAuth: authenticate, // old name, kept so nothing importing it breaks
  requireAdmin,
  hashPassword,
  verifyPassword,
  checkCredentials,
  mintSession,
  readSession,
  setSessionCookie,
  clearSessionCookie,
  formLoginAvailable,
  isLockedOut,
  noAuthConfigured,
  COOKIE_NAME,
};
