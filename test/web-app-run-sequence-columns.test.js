'use strict';
// web/app.js is a browser IIFE, so (as in the other web/app.js vm tests)
// evaluate meetingColumns() + runSequence() together in a vm context, with
// runTurn/setRunning/toast/generateMeetingMinutes/loadSessions stubbed the
// way the app itself calls them, and a minimal fake DOM in place of #transcript.
//
// Bug: runSequence only ever built columns for a full 3-agent trio
// (gridEligible), so a resumed meeting's 2 remaining agents, or a single
// Retry, fell through to `cols = null` and runTurn(turn, undefined) — the
// turn rendered full-width below the grid instead of in its agent's column.
// The fix widens the check to "every turn is the same standard-meeting mode,
// spoken by a real agent" (`columned`), regardless of count, and reuses the
// existing grid via meetingColumns() instead of always creating one.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const ALL = ['regulatory', 'clinical', 'commercial']; // Ruth, Luca, Charlie
const GRID_MODES = ['opening', 'round2', 'round3', 'crosstalk'];

// Same minimal fake element as web-app-meeting-columns.test.js — meetingColumns
// and runSequence together touch nothing else on it.
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this._classes = [];
    this.dataset = {};
    this.children = [];
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }

  get className() { return this._classes.join(' '); }

  set className(v) { this._classes = String(v).split(/\s+/).filter(Boolean); }

  get classList() {
    const self = this;
    return { contains: (c) => self._classes.includes(c) };
  }

  appendChild(el) { this.children.push(el); return el; }

  get lastElementChild() { return this.children.length ? this.children[this.children.length - 1] : null; }

  querySelector(sel) {
    const m = /^:scope > \.([\w-]+)\[data-speaker="([^"]+)"\]$/.exec(sel);
    if (!m) return null; // e.g. `$('.empty', t)` — nothing in these tests ever matches
    const [, cls, speaker] = m;
    return this.children.find((c) => c._classes.includes(cls) && c.dataset.speaker === speaker) || null;
  }
}

// runTurnResult: 'ok' (default), or a function (turn, container) => boolean/throws,
// for tests that need a turn to fail.
function loadHelpers({ running = false, runTurnResult = 'ok' } = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf("  // The columns a live meeting's turns stream into, keyed by agent.");
  const end = src.indexOf('  // Round 1 specifically');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did meetingColumns/runSequence move?');

  const t = new FakeElement('div');
  const calls = { runTurn: [], setRunning: [], toast: [], generateMeetingMinutes: [], loadSessions: 0 };
  const ctx = {
    ALL, GRID_MODES,
    state: { running, stopRequested: false },
    document: {
      createElement: (tag) => new FakeElement(tag),
      querySelector: (sel) => (sel === '#transcript' ? t : null),
    },
    setRunning: (v) => { ctx.state.running = v; calls.setRunning.push(v); },
    toast: (msg) => calls.toast.push(msg),
    runTurn: async (turn, container) => {
      calls.runTurn.push({ turn, container });
      if (typeof runTurnResult === 'function') return runTurnResult(turn, container);
      return true;
    },
    generateMeetingMinutes: (mode) => calls.generateMeetingMinutes.push(mode),
    loadSessions: () => { calls.loadSessions += 1; },
  };
  ctx.$ = (sel, root = ctx.document) => root.querySelector(sel);
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\nthis.runSequence = runSequence; this.meetingColumns = meetingColumns;`, ctx);
  ctx.calls = calls;
  ctx.t = t;
  return ctx;
}

describe('web/app.js runSequence column assignment', () => {
  it('does nothing when a turn is already running', async () => {
    const ctx = loadHelpers({ running: true });
    await ctx.runSequence([{ speaker: 'regulatory', mode: 'round2' }]);
    assert.deepEqual(ctx.calls, { runTurn: [], setRunning: [], toast: ['A turn is already running'], generateMeetingMinutes: [], loadSessions: 0 });
  });

  it('a fresh 3-agent round runs in columns and generates minutes (normal case)', async () => {
    const ctx = loadHelpers();
    const turns = ALL.map((a) => ({ speaker: a, mode: 'round2' }));

    await ctx.runSequence(turns);

    assert.equal(ctx.t.children.length, 1, 'one grid built');
    assert.equal(ctx.calls.runTurn.length, 3);
    for (const call of ctx.calls.runTurn) {
      assert.notEqual(call.container, undefined, `${call.turn.speaker}'s turn got a column container`);
      assert.equal(call.container.dataset.speaker, call.turn.speaker);
    }
    assert.deepEqual(ctx.calls.generateMeetingMinutes, ['round2']);
  });

  it('a 2-agent resume reuses the existing grid and gives each turn its own column', async () => {
    const ctx = loadHelpers();
    // Simulate the grid left over from Ruth's already-finished round2 turn.
    const existingCols = ctx.meetingColumns(ctx.t, 'round2');
    const turns = [
      { speaker: 'clinical', mode: 'round2' },
      { speaker: 'commercial', mode: 'round2' },
    ];

    await ctx.runSequence(turns);

    assert.equal(ctx.t.children.length, 1, 'no second grid appended — the existing one was reused');
    assert.equal(ctx.calls.runTurn.length, 2);
    assert.equal(ctx.calls.runTurn[0].container, existingCols.clinical);
    assert.equal(ctx.calls.runTurn[1].container, existingCols.commercial);
    for (const call of ctx.calls.runTurn) assert.notEqual(call.container, undefined);
    // Not a full trio in this call, so no fresh set of minutes is generated.
    assert.deepEqual(ctx.calls.generateMeetingMinutes, []);
  });

  it('a single-agent Retry gets a column container, not undefined', async () => {
    const ctx = loadHelpers();
    const turns = [{ speaker: 'clinical', mode: 'round2' }];

    await ctx.runSequence(turns);

    assert.equal(ctx.calls.runTurn.length, 1);
    assert.notEqual(ctx.calls.runTurn[0].container, undefined);
    assert.equal(ctx.calls.runTurn[0].container.dataset.speaker, 'clinical');
  });

  it('a custom-mode sequence gets no container (renders full-width, not in a column)', async () => {
    const ctx = loadHelpers();
    const turns = [{ speaker: 'clinical', mode: 'custom', instruction: 'focus on pricing' }];

    await ctx.runSequence(turns);

    assert.equal(ctx.t.children.length, 0, 'no grid built for a custom turn');
    assert.equal(ctx.calls.runTurn.length, 1);
    assert.equal(ctx.calls.runTurn[0].container, undefined);
  });

  it('a mixed-mode sequence (e.g. reply) gets no container', async () => {
    const ctx = loadHelpers();
    const turns = [
      { speaker: 'clinical', mode: 'reply' },
      { speaker: 'commercial', mode: 'reply' },
    ];

    await ctx.runSequence(turns);

    assert.equal(ctx.t.children.length, 0);
    for (const call of ctx.calls.runTurn) assert.equal(call.container, undefined);
  });

  it('starts a fresh grid instead of reusing one for a different standard mode', async () => {
    const ctx = loadHelpers();
    const priorCols = ctx.meetingColumns(ctx.t, 'opening');
    const turns = [{ speaker: 'clinical', mode: 'round2' }];

    await ctx.runSequence(turns);

    assert.equal(ctx.t.children.length, 2, 'opening grid kept, a new round2 grid added');
    assert.notEqual(ctx.calls.runTurn[0].container, priorCols.clinical);
    assert.equal(ctx.calls.runTurn[0].container.dataset.speaker, 'clinical');
  });
});
