'use strict';
// Meetings are driven turn by turn from the browser, so leaving the page
// mid-meeting (session 39: a navigation to /guide during Luca's Challenge
// turn) strands the running turn and never asks the remaining agents.
// web/app.js registers a beforeunload guard that prompts only while a
// meeting/autopilot/report is running. Evaluated in a vm like the other
// web/app.js tests, since the file is a browser IIFE.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

function slice(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  const end = SRC.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `markers not found in web/app.js: ${startMarker}`);
  return SRC.slice(start, end);
}

function loadGuard(running) {
  const ctx = { state: { running } };
  vm.createContext(ctx);
  vm.runInContext(`let signingInAgain = false;\n${slice('  function warnIfMeetingRunning(', '  // ---------------- running turns')}\nthis.guard = warnIfMeetingRunning; this.setSigningIn = (v) => { signingInAgain = v; };`, ctx);
  return ctx;
}

function fakeEvent() {
  const e = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
  return e;
}

describe('web/app.js leave-page guard', () => {
  it('is registered on beforeunload', () => {
    assert.match(SRC, /addEventListener\('beforeunload', warnIfMeetingRunning\)/);
  });

  it('asks for confirmation while a meeting is running', () => {
    const ctx = loadGuard(true);
    const e = fakeEvent();
    ctx.guard(e);
    assert.equal(e.prevented, true);
    assert.equal(e.returnValue, '');
  });

  it('does not prompt when nothing is running', () => {
    const ctx = loadGuard(false);
    const e = fakeEvent();
    ctx.guard(e);
    assert.equal(e.prevented, false);
    assert.equal(e.returnValue, undefined);
  });

  it('does not block the app\'s own redirect to sign-in after a 401, even mid-meeting', () => {
    const ctx = loadGuard(true);
    ctx.setSigningIn(true);
    const e = fakeEvent();
    ctx.guard(e);
    assert.equal(e.prevented, false);
  });

  it('a 401 sets the flag that lets the sign-in redirect past the guard', async () => {
    const ctx = { location: { pathname: '/', search: '?session=39', href: '' } };
    vm.createContext(ctx);
    vm.runInContext(`${slice('// ---------------- API', '  const api = {')}\nthis.signIn = signInAgainIf401; this.flag = () => signingInAgain;`, ctx);
    assert.equal(ctx.flag(), false);
    ctx.signIn({ status: 200 });
    assert.equal(ctx.flag(), false);
    ctx.signIn({ status: 401 });
    assert.equal(ctx.flag(), true);
  });
});
