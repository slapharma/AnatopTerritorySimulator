'use strict';
// nextMeeting() and startMeeting() (web/app.js): the sidebar's toolbar round
// buttons and the Minutes tab's "Approve and continue" button both funnel
// through startMeeting(mode) — this used to be an inline handler on the
// toolbar buttons only. As in the other web/app.js vm tests, the relevant
// functions are sliced out by string markers and run in a vm context.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const ALL = ['regulatory', 'clinical', 'commercial'];
const GRID_MODES = ['opening', 'round2', 'round3', 'crosstalk'];
const MODE_LABEL = { opening: 'Baselines', round2: 'Challenge', round3: 'Converge', crosstalk: 'Cross-talk' };

function loadHelpers({ messages = [], running = false, confirmReturns = true } = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf('  function agentsAnswered(mode) {');
  const end = src.indexOf('  // The columns a live meeting');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did agentsAnswered/startMeeting move?');

  const calls = { toasts: [], runSequence: [], runRound1Parallel: 0, confirms: [] };
  const ctx = {
    ALL, GRID_MODES, MODE_LABEL, Set,
    state: { session: { messages: messages.slice() }, running },
    toast: (msg) => { calls.toasts.push(msg); return undefined; },
    confirm: (msg) => { calls.confirms.push(msg); return confirmReturns; },
    runSequence: async (turns) => calls.runSequence.push(turns),
    runRound1Parallel: async () => { calls.runRound1Parallel++; },
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}
this.nextMeeting = nextMeeting;
this.startMeeting = startMeeting;
this.unmetPriorRound = unmetPriorRound;
this.turnsForRound = turnsForRound;`, ctx);
  ctx.calls = calls;
  return ctx;
}

let seq = 0;
const row = (speaker, mode, over = {}) => ({ id: ++seq, seq, role: 'agent', speaker, mode, error: null, text: 'answer', ...over });

describe('web/app.js nextMeeting', () => {
  it('names round2 after opening, round3 after round2, crosstalk after round3', () => {
    const ctx = loadHelpers({});
    assert.equal(ctx.nextMeeting('opening'), 'round2');
    assert.equal(ctx.nextMeeting('round2'), 'round3');
    assert.equal(ctx.nextMeeting('round3'), 'crosstalk');
  });

  it('returns null after the last standard meeting (crosstalk)', () => {
    const ctx = loadHelpers({});
    assert.equal(ctx.nextMeeting('crosstalk'), null);
  });

  it('returns null for a mode not on the standard agenda (e.g. a custom or question turn)', () => {
    const ctx = loadHelpers({});
    assert.equal(ctx.nextMeeting('custom'), null);
    assert.equal(ctx.nextMeeting('question'), null);
  });
});

describe('web/app.js startMeeting', () => {
  it('toasts and runs nothing when a turn is already running', () => {
    const ctx = loadHelpers({ running: true });

    ctx.startMeeting('opening');

    assert.equal(ctx.calls.toasts.length, 1);
    assert.equal(ctx.calls.runSequence.length, 0);
    assert.equal(ctx.calls.runRound1Parallel, 0);
  });

  it('toasts and runs nothing when an earlier standard meeting is incomplete', () => {
    // Only 2 of 3 agents answered opening — round2 cannot start yet.
    const ctx = loadHelpers({ messages: [row('regulatory', 'opening'), row('clinical', 'opening')] });

    ctx.startMeeting('round2');

    assert.match(ctx.calls.toasts[0], /Run Baselines for all 3 agents before starting Challenge\./);
    assert.equal(ctx.calls.runSequence.length, 0);
  });

  it('runs Round 1 in parallel when opening is fully pending (no responses yet)', async () => {
    const ctx = loadHelpers({ messages: [] });

    await ctx.startMeeting('opening');

    assert.equal(ctx.calls.runRound1Parallel, 1);
    assert.equal(ctx.calls.runSequence.length, 0);
  });

  it('runs a sequence of all agents when a non-opening round is fully pending', async () => {
    const ctx = loadHelpers({ messages: ALL.map((a) => row(a, 'opening')) }); // opening complete, round2 untouched

    await ctx.startMeeting('round2');

    assert.equal(ctx.calls.runSequence.length, 1);
    assert.deepEqual(ctx.calls.runSequence[0].map((t) => t.speaker), ALL);
    assert.ok(ctx.calls.runSequence[0].every((t) => t.mode === 'round2'));
  });

  it('resumes only the agents that have not yet answered when the round is partially done', async () => {
    const ctx = loadHelpers({
      messages: [...ALL.map((a) => row(a, 'opening')), row('regulatory', 'round2')], // round2 missing clinical, commercial
    });

    await ctx.startMeeting('round2');

    assert.match(ctx.calls.toasts[0], /Resuming Challenge: 2 agent\(s\) haven't answered yet\./);
    assert.equal(ctx.calls.runSequence.length, 1);
    assert.deepEqual(ctx.calls.runSequence[0].map((t) => t.speaker), ['clinical', 'commercial']);
  });

  it('asks to confirm, then re-runs every agent, when the round already has a response from everyone', async () => {
    const ctx = loadHelpers({ messages: [...ALL.map((a) => row(a, 'opening')), ...ALL.map((a) => row(a, 'round2'))] });

    await ctx.startMeeting('round2');

    assert.equal(ctx.calls.confirms.length, 1);
    assert.equal(ctx.calls.runSequence.length, 1);
    assert.deepEqual(ctx.calls.runSequence[0].map((t) => t.speaker), ALL);
  });

  it('runs nothing when the moderator declines the re-run confirmation', async () => {
    const ctx = loadHelpers({
      messages: [...ALL.map((a) => row(a, 'opening')), ...ALL.map((a) => row(a, 'round2'))],
      confirmReturns: false,
    });

    await ctx.startMeeting('round2');

    assert.equal(ctx.calls.runSequence.length, 0);
    assert.equal(ctx.calls.runRound1Parallel, 0);
  });
});
