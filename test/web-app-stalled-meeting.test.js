'use strict';
// web/app.js is a browser IIFE, so (as in web-app-round-completion.test.js)
// evaluate just stalledMeeting() plus the turnsForRound helpers it depends on,
// in a vm context against a fake state.
//
// Session 39: a Challenge meeting was interrupted while Luca's turn was in
// flight (his row left with text NULL, no error), and the toolbar needed a
// way to tell "this meeting is stopped, not just unstarted" from a single
// pure function so renderMeetingNav and the Resume button can both use it.
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
  const stalledStart = src.indexOf('  // The latest standard meeting that has been started');
  const stalledEnd = src.indexOf('  function renderMinutes(');
  assert.ok(stalledStart >= 0 && stalledEnd > stalledStart, 'markers not found in web/app.js — did stalledMeeting move?');
  const turnsStart = src.indexOf('  // Agents in `agents` that don');
  const turnsEnd = src.indexOf('  async function runSequence(');
  assert.ok(turnsStart >= 0 && turnsEnd > turnsStart, 'markers not found in web/app.js — did turnsForRound move?');
  const ctx = { state: { session: { messages } }, ALL, GRID_MODES, Set };
  vm.createContext(ctx);
  const body = `${src.slice(turnsStart, turnsEnd)}\n${src.slice(stalledStart, stalledEnd)}\nthis.stalledMeeting = stalledMeeting;`;
  vm.runInContext(body, ctx);
  return ctx;
}

// stalledMeeting()'s return value is built inside the vm context, so its
// Object/Array prototypes aren't reference-equal to this file's — assert/strict's
// deepEqual checks that identity and fails on an otherwise-identical value.
// Round-tripping through JSON gives back a plain object in this realm.
const plain = (v) => (v === null ? null : JSON.parse(JSON.stringify(v)));

let seq = 0;
const row = (speaker, mode, extra = {}) => ({ id: ++seq, seq, role: 'agent', speaker, mode, text: 'answer', error: null, ...extra });
const openingDone = () => ALL.map((a) => row(a, 'opening'));

describe('web/app.js stalledMeeting', () => {
  it('returns null when there are no messages', () => {
    const ctx = loadHelpers([]);
    assert.equal(ctx.stalledMeeting(), null);
  });

  it('returns null when the latest started meeting is fully answered', () => {
    const ctx = loadHelpers([...openingDone()]);
    assert.equal(ctx.stalledMeeting(), null);
  });

  it('reports pending clinical and commercial when clinical\'s row has text NULL (the production case)', () => {
    const ctx = loadHelpers([...openingDone(), row('regulatory', 'round2'), row('clinical', 'round2', { text: null })]);
    assert.deepEqual(plain(ctx.stalledMeeting()), { mode: 'round2', pending: ['clinical', 'commercial'] });
  });

  it('treats an errored row as pending, not answered', () => {
    const ctx = loadHelpers([...openingDone(), row('regulatory', 'round2'), row('clinical', 'round2', { text: '', error: 'boom' }), row('commercial', 'round2')]);
    assert.deepEqual(plain(ctx.stalledMeeting()), { mode: 'round2', pending: ['clinical'] });
  });

  it('looks only at the latest started standard meeting, ignoring an earlier round\'s gap', () => {
    // round2 is missing commercial, but round3 (the later meeting) went ahead
    // and every agent answered it — stalledMeeting must report on round3 only.
    const ctx = loadHelpers([
      ...openingDone(),
      row('regulatory', 'round2'), row('clinical', 'round2'),
      ...ALL.map((a) => row(a, 'round3')),
    ]);
    assert.equal(ctx.stalledMeeting(), null);
  });

  it('picks up a stalled crosstalk over an unfinished but earlier round2', () => {
    const ctx = loadHelpers([
      ...openingDone(),
      row('regulatory', 'round2'), row('clinical', 'round2'),
      row('regulatory', 'crosstalk'), row('clinical', 'crosstalk', { text: null }),
    ]);
    assert.deepEqual(plain(ctx.stalledMeeting()), { mode: 'crosstalk', pending: ['clinical', 'commercial'] });
  });

  it('ignores non-agent rows: a user message in round2 neither starts nor completes it', () => {
    const ctx = loadHelpers([
      ...openingDone(),
      row('regulatory', 'round2'),
      { id: ++seq, seq, role: 'user', mode: 'round2', speaker: undefined, text: 'a note from the moderator', error: null },
    ]);
    assert.deepEqual(plain(ctx.stalledMeeting()), { mode: 'round2', pending: ['clinical', 'commercial'] });
  });
});
