'use strict';
// web/app.js is a browser IIFE, so (as in web-app-401.test.js) evaluate just
// the round-completion helpers in a vm context against a fake state.
//
// Session 39: a Challenge meeting was interrupted while Luca's turn was in
// flight, leaving his row with text NULL and no error. Clicking Challenge
// again must re-run Luca AND Charlie, not skip Luca as "already answered",
// and Converge must stay blocked until Luca has actually answered.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const ALL = ['regulatory', 'clinical', 'commercial']; // Ruth, Luca, Charlie
const GRID_MODES = ['opening', 'round2', 'round3', 'crosstalk'];

function loadHelpers(messages) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf('  // Agents in `agents` that don');
  const end = src.indexOf('  async function runSequence(');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did turnsForRound move?');
  const ctx = { state: { session: { messages } }, ALL, GRID_MODES, Set };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\nthis.turnsForRound = turnsForRound; this.unmetPriorRound = unmetPriorRound;`, ctx);
  return ctx;
}

let seq = 0;
const row = (speaker, mode, extra = {}) => ({ id: ++seq, seq, role: 'agent', speaker, mode, text: 'answer', error: null, ...extra });
const openingDone = () => ALL.map((a) => row(a, 'opening'));

describe('web/app.js round completion', () => {
  it('re-running Challenge after an interrupted Luca turn runs Luca and Charlie, not just Charlie', () => {
    const ctx = loadHelpers([...openingDone(), row('regulatory', 'round2'), row('clinical', 'round2', { text: null })]);
    assert.deepEqual([...ctx.turnsForRound('round2', ALL)], ['clinical', 'commercial']);
  });

  it('a failed row (error set) is also not an answer', () => {
    const ctx = loadHelpers([...openingDone(), row('regulatory', 'round2'), row('clinical', 'round2', { text: '', error: 'boom' })]);
    assert.deepEqual([...ctx.turnsForRound('round2', ALL)], ['clinical', 'commercial']);
  });

  it('Converge is blocked while a Challenge row is unfinished', () => {
    const ctx = loadHelpers([...openingDone(), row('regulatory', 'round2'), row('clinical', 'round2', { text: null }), row('commercial', 'round2')]);
    assert.equal(ctx.unmetPriorRound('round3'), 'round2');
  });

  it('Converge is allowed once all three have answered Challenge', () => {
    const ctx = loadHelpers([...openingDone(), ...ALL.map((a) => row(a, 'round2'))]);
    assert.equal(ctx.unmetPriorRound('round3'), null);
    assert.deepEqual([...ctx.turnsForRound('round2', ALL)], []);
  });
});
