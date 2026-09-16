'use strict';
// web/login.html keeps its script inline, so there is nothing to require.
// Pull the safeNext function out of the page source and run it in a vm
// context with a fake location, the same way test/web-app-401.test.js does
// for web/app.js. If the function is renamed or reshaped, this fails loudly
// (`safeNext not found`) rather than silently testing nothing.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LOGIN_HTML = path.join(__dirname, '..', 'web', 'login.html');
const ORIGIN = 'https://app.example';

function loadSafeNext(search) {
  const src = fs.readFileSync(LOGIN_HTML, 'utf8');
  const match = src.match(/function safeNext\(\) \{[\s\S]*?\r?\n {4}\}\r?\n/);
  assert.ok(match, 'safeNext not found in web/login.html — did it move or get renamed?');

  const ctx = {
    location: { search, origin: ORIGIN, href: `${ORIGIN}/login${search}` },
    URL, URLSearchParams,
  };
  vm.createContext(ctx);
  vm.runInContext(`${match[0]}\nthis.safeNext = safeNext;`, ctx);
  return ctx.safeNext;
}

// What the browser would actually navigate to after `location.href = next`.
function landsOn(next) {
  return new URL(next, `${ORIGIN}/login`).href;
}

const withNext = (value) => `?next=${encodeURIComponent(value)}`;

describe('web/login.html safeNext — post-sign-in redirect target', () => {
  const offsite = [
    ['backslash after slash', withNext('/\\evil.com')],
    ['URL-encoded backslash', '?next=/%5Cevil.com'],
    ['protocol-relative', withNext('//evil.com')],
    ['absolute URL', withNext('https://evil.com')],
    ['tab between slashes (stripped by the URL parser)', withNext('/\t/evil.com')],
    ['javascript: URL', withNext('javascript:alert(1)')],
    // Dot segments collapse during parsing, so the pathname itself can come
    // out as `//evil.com` even though the parsed origin matched.
    ['dot segment before a double slash', withNext('/.//evil.com')],
    ['parent segment before a double slash', withNext('/a/..//evil.com')],
    ['encoded dot segments', '?next=/%2e%2e//evil.com'],
    ['own origin with a double-slash path', withNext(`${ORIGIN}//evil.com`)],
  ];

  for (const [label, search] of offsite) {
    it(`stays on site for ${label}`, () => {
      const next = loadSafeNext(search)();
      assert.equal(new URL(landsOn(next)).origin, ORIGIN, `next resolved to ${next}`);
    });
  }

  it('keeps a legitimate same-origin path with its query', () => {
    assert.equal(loadSafeNext(withNext('/?session=39'))(), `${ORIGIN}/?session=39`);
  });

  it('keeps path, query and hash together', () => {
    assert.equal(loadSafeNext(withNext('/guide.html?x=1#part'))(), `${ORIGIN}/guide.html?x=1#part`);
  });

  it('defaults to / when next is absent', () => {
    assert.equal(loadSafeNext('')(), `${ORIGIN}/`);
  });
});
