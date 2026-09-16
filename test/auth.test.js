'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/start-app');

const EMAIL = 'user@example.com';
const PASSWORD = 'correct horse battery staple';

describe('session cookie lifetime and authenticate()', () => {
  let server, auth, baseUrl;
  const state = { failGetUser: false };
  const passwordHashRef = { value: null };

  before(async () => {
    const harness = await startApp({
      // Off Vercel with a user on file: avoids the noAuthConfigured dev
      // bypass (!VERCEL && countUsers()===0), so authenticate() actually
      // runs its own logic instead of waving every request through.
      countUsers: async () => 1,
      getUserByEmail: async (email) => (email === EMAIL
        ? { id: 1, email: EMAIL, password_hash: passwordHashRef.value, is_admin: false }
        : null),
      getUserById: async (id) => {
        if (state.failGetUser) throw new Error('db down');
        return id === 1 ? { id: 1, email: EMAIL, is_admin: false } : null;
      },
    });
    server = harness.server;
    auth = harness.auth;
    baseUrl = harness.baseUrl;
    passwordHashRef.value = await auth.hashPassword(PASSWORD);
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('POST /login sets a cookie that lives 12 hours (Max-Age=43200), not 43 seconds', async () => {
    const r = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert.equal(r.status, 200);
    const setCookie = r.headers.get('set-cookie');
    assert.ok(setCookie, 'expected a Set-Cookie header on successful login');
    assert.match(setCookie, /^anatop_session=/);

    const maxAge = Number((setCookie.match(/Max-Age=(\d+)/) || [])[1]);
    assert.equal(maxAge, 43200, 'cookie Max-Age must be 43200 seconds (12h), not seconds-as-milliseconds\' 43');

    const expires = new Date((setCookie.match(/Expires=([^;]+)/) || [])[1]);
    const lifeSeconds = Math.round((expires.getTime() - Date.now()) / 1000);
    assert.ok(Math.abs(lifeSeconds - 43200) <= 5, `Expires should be ~12h out, was ${lifeSeconds}s`);
  });

  it('POST /logout clears the cookie (Max-Age=0)', async () => {
    const r = await fetch(`${baseUrl}/logout`, { method: 'POST' });
    assert.equal(r.status, 200);
    const setCookie = r.headers.get('set-cookie');
    assert.ok(setCookie, 'expected a Set-Cookie header on logout');
    assert.match(setCookie, /Max-Age=0\b/);
  });

  it('a valid session cookie authenticates a normal request', async () => {
    const token = auth.mintSession({ id: 1 });
    const r = await fetch(`${baseUrl}/api/me`, {
      headers: { cookie: `anatop_session=${token}`, accept: 'application/json' },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body, { authenticated: true, id: 1, email: EMAIL, is_admin: false });
  });

  it('no cookie at all is rejected with 401 Not signed in, not a silent pass-through', async () => {
    const r = await fetch(`${baseUrl}/api/me`, { headers: { accept: 'application/json' } });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.deepEqual(body, { error: 'Not signed in.' });
  });

  it('a database error while resolving the session answers 503, not 401', async () => {
    const token = auth.mintSession({ id: 1 });
    state.failGetUser = true;
    try {
      const r = await fetch(`${baseUrl}/api/me`, {
        headers: { cookie: `anatop_session=${token}`, accept: 'application/json' },
      });
      assert.equal(r.status, 503);
      const body = await r.json();
      assert.notEqual(body.error, 'Not signed in.');
      assert.ok(body.error && body.error.length > 0);
    } finally {
      state.failGetUser = false;
    }
  });
});
