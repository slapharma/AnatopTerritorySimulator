'use strict';
// web/app.js is a browser IIFE, not a CommonJS module — no `require`, no
// exports. To exercise signInAgainIf401 without a real DOM/browser, evaluate
// just the "API" section of the file (fetch/location wrapper) in a vm
// context with a fake fetch and location, the same way the rest of the app
// consumes it. If the marker comments this test relies on ever move, this
// fails loudly (`markers not found`) rather than silently testing nothing.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');

function loadApi(fetchImpl, initialLocation) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf('// ---------------- API');
  const end = src.indexOf('// ---------------- helpers');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did the API section move?');

  const ctx = {
    location: initialLocation,
    fetch: fetchImpl,
    URLSearchParams, encodeURIComponent, JSON, Promise, Error, setTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\nthis.api = api;`, ctx);
  return ctx;
}

// Races a promise against a short timer so a promise that is *supposed* to
// never settle (the 401 case navigates away instead of resolving/rejecting)
// can be asserted on without hanging the test.
function outcome(p) {
  return Promise.race([
    p.then((v) => ({ kind: 'resolved', value: v }), (e) => ({ kind: 'threw', message: e.message })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'pending' }), 100)),
  ]);
}

describe('web/app.js api.get/api.send — 401 handling', () => {
  it('a 401 redirects to /login with the current path+query and never settles', async () => {
    const ctx = loadApi(
      async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: 'Not signed in.' }) }),
      { pathname: '/', search: '?session=39', href: 'https://x/?session=39' },
    );
    const result = await outcome(ctx.api.get('/api/sessions/39'));
    assert.equal(result.kind, 'pending', 'a 401 must never resolve or reject api.get\'s promise');
    assert.equal(ctx.location.href, '/login?next=%2F%3Fsession%3D39');
  });

  it('a non-401 error status still throws and does not navigate', async () => {
    const ctx = loadApi(
      async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({ error: 'db down' }) }),
      { pathname: '/', search: '', href: 'unchanged' },
    );
    const result = await outcome(ctx.api.send('POST', '/api/sessions/39/turn', {}));
    assert.equal(result.kind, 'threw');
    assert.equal(result.message, 'db down');
    assert.equal(ctx.location.href, 'unchanged');
  });

  it('a 200 response resolves normally with the parsed body', async () => {
    const ctx = loadApi(
      async () => ({ ok: true, status: 200, json: async () => ({ fine: 1 }) }),
      { pathname: '/', search: '', href: 'unchanged' },
    );
    const result = await outcome(ctx.api.get('/api/config'));
    assert.deepEqual(result, { kind: 'resolved', value: { fine: 1 } });
    assert.equal(ctx.location.href, 'unchanged');
  });
});
