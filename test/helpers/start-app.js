'use strict';
// Shared test harness: boots the real src/app.js against an in-memory fake
// src/db.js, on an OS-assigned port we control, so tests never touch the
// production database and can close the server cleanly afterwards.
//
// src/app.js calls app.listen() itself at module load time (guarded by
// `if (!process.env.VERCEL)`), with no exported handle to the server it
// creates. To get a handle we can close, we temporarily replace
// express.application.listen — which every express() instance shares by
// reference (mixin(app, proto, false) copies the *current* value of the
// prototype at app-creation time) — with a wrapper that forces port 0 and
// captures the resulting net.Server before restoring the original.
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function startApp(dbOverrides = {}) {
  // Never let a real DATABASE_URL or a Vercel runtime flag leak in from the
  // parent process; this worktree ships no .env, so bootstrap below adds
  // nothing back, but belt and braces matches the rest of this test setup.
  delete process.env.DATABASE_URL;
  delete process.env.VERCEL;
  require(path.join(ROOT, 'src', 'bootstrap'));
  delete process.env.DATABASE_URL;
  if (!process.env.AUTH_SECRET) process.env.AUTH_SECRET = 'test-secret-do-not-use-in-prod';

  // Fake db BEFORE anything requires src/app or src/auth, both of which
  // `require('./db')` at module load and capture whatever is cached then.
  const dbPath = require.resolve(path.join(ROOT, 'src', 'db'));
  const fakeDb = Object.assign({ pool: { on() {} } }, dbOverrides);
  const handler = { get: (t, k) => (k in t ? t[k] : async () => []) };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: new Proxy(fakeDb, handler) };

  const express = require('express');
  const originalListen = express.application.listen;
  let server = null;
  express.application.listen = function patchedListen(...args) {
    const cb = args.find((a) => typeof a === 'function');
    server = originalListen.call(this, 0, cb);
    return server;
  };
  const app = require(path.join(ROOT, 'src', 'app'));
  express.application.listen = originalListen;

  const auth = require(path.join(ROOT, 'src', 'auth'));
  const config = require(path.join(ROOT, 'src', 'config'));

  return new Promise((resolve, reject) => {
    if (!server) return reject(new Error('src/app.js did not call listen() — is VERCEL set?'));
    const done = () => resolve({ app, server, db: fakeDb, auth, config, baseUrl: `http://127.0.0.1:${server.address().port}` });
    if (server.listening) return done();
    server.once('listening', done);
    server.once('error', reject);
  });
}

module.exports = { startApp, ROOT };
