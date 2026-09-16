'use strict';
// web/app.js is a browser IIFE, so (as in the other web/app.js vm tests)
// evaluate just resumeStalledMeeting() and its dependencies (stalledMeeting,
// turnsForRound/agentsAnswered/unmetPriorRound) in a vm context, with
// api/confirm/toast/runSequence/renderTranscript stubbed the way the app
// itself calls them.
//
// Session 39: a Challenge meeting was interrupted while Luca's turn was in
// flight, leaving his round2 row with text NULL and Charlie never asked.
// Resuming must clear only Luca's stuck row (not Ruth's finished one, not a
// stray row from a different meeting) and then ask Luca and Charlie, in
// that order.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const ALL = ['regulatory', 'clinical', 'commercial']; // Ruth, Luca, Charlie
const GRID_MODES = ['opening', 'round2', 'round3', 'crosstalk'];
const MODE_LABEL = { opening: 'Baselines', round2: 'Challenge', round3: 'Converge', crosstalk: 'Cross-talk' };
const AGENT_LABEL = { regulatory: 'Ruth', clinical: 'Luca', commercial: 'Charlie' };

// serverMessages: what GET /api/sessions/39 returns (defaults to `messages`,
// the page's local copy). confirmReturns: one boolean for every confirm(), or
// an array consumed in order.
function loadHelpers({ running = false, messages, serverMessages, confirmReturns = true, deleteImpl } = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const stalledStart = src.indexOf('  // The latest standard meeting that has been started');
  const stalledEnd = src.indexOf('  function renderMinutes(');
  assert.ok(stalledStart >= 0 && stalledEnd > stalledStart, 'markers not found in web/app.js — did stalledMeeting/resumeStalledMeeting move?');
  const turnsStart = src.indexOf('  // Agents in `agents` that don');
  const turnsEnd = src.indexOf('  async function runSequence(');
  assert.ok(turnsStart >= 0 && turnsEnd > turnsStart, 'markers not found in web/app.js — did turnsForRound move?');

  const calls = { deletes: [], toasts: [], runSequence: [], renderTranscript: 0, gets: 0, confirms: [], running: [] };
  const answers = Array.isArray(confirmReturns) ? [...confirmReturns] : null;
  const ctx = {
    state: { running, session: { id: 39, messages } },
    ALL, GRID_MODES, MODE_LABEL, AGENT_LABEL, Set, Date,
    fmtRelative: () => 'moments ago',
    setRunning: (on) => { ctx.state.running = on; calls.running.push(on); },
    confirm: (text) => { calls.confirms.push(text); return answers ? answers.shift() : confirmReturns; },
    toast: (text) => { calls.toasts.push(text); },
    renderTranscript: () => { calls.renderTranscript += 1; },
    // runSequence refuses to start while state.running is set, as the real one does.
    runSequence: async (turns) => { assert.equal(ctx.state.running, false, 'runSequence called while controls still held'); calls.runSequence.push(turns); },
    api: {
      get: async () => { calls.gets += 1; return { id: 39, messages: serverMessages || messages }; },
      send: async (method, url) => {
        calls.deletes.push({ method, url });
        if (deleteImpl) return deleteImpl(method, url);
        return {};
      },
    },
  };
  vm.createContext(ctx);
  const body = `${src.slice(turnsStart, turnsEnd)}\n${src.slice(stalledStart, stalledEnd)}\nthis.resumeStalledMeeting = resumeStalledMeeting; this.stalledMeeting = stalledMeeting;`;
  vm.runInContext(body, ctx);
  ctx.calls = calls;
  return ctx;
}

// runSequence's argument is built inside the vm context, so its objects'
// prototypes aren't reference-equal to this file's — assert/strict's deepEqual
// checks that identity too. Round-tripping through JSON gives back plain
// objects in this realm for the comparison.
const plain = (v) => JSON.parse(JSON.stringify(v));

let seq = 0;
// Rows default to an hour old, well past the "may still be running" window.
const HOUR_AGO = () => new Date(Date.now() - 3600000).toISOString();
const row = (speaker, mode, extra = {}) => ({ id: ++seq, seq, role: 'agent', speaker, mode, text: 'answer', error: null, created_at: HOUR_AGO(), ...extra });
const openingDone = () => ALL.map((a) => row(a, 'opening'));

// The production case: Baselines finished by all three, Ruth (regulatory)
// answered Challenge, Luca's (clinical) Challenge row got cut off (text
// NULL), Charlie (commercial) was never asked. A stray, already-errored row
// left over in Baselines for Luca must not be touched by a Challenge resume.
function productionMessages() {
  return [
    ...openingDone(),
    row('clinical', 'opening', { error: 'stray old error from a prior run' }),
    row('regulatory', 'round2'),
    row('clinical', 'round2', { text: null }),
  ];
}

describe('web/app.js resumeStalledMeeting', () => {
  it('does nothing when a turn is already running', async () => {
    const ctx = loadHelpers({ running: true, messages: productionMessages() });
    await ctx.resumeStalledMeeting();
    assert.deepEqual(ctx.calls, { deletes: [], toasts: [], runSequence: [], renderTranscript: 0, gets: 0, confirms: [], running: [] });
  });

  it('says there is nothing to resume, and deletes nothing, when the server copy is complete', async () => {
    const ctx = loadHelpers({ running: false, messages: productionMessages(), serverMessages: openingDone() });
    await ctx.resumeStalledMeeting();
    assert.equal(ctx.calls.gets, 1);
    assert.equal(ctx.calls.deletes.length, 0);
    assert.equal(ctx.calls.runSequence.length, 0);
    assert.equal(ctx.calls.confirms.length, 0);
    assert.match(ctx.calls.toasts[0], /Nothing to resume/);
  });

  it('works from the server copy: clears a stuck row the page never had', async () => {
    // A turn that failed on this page is not in the local list; the server has it.
    const local = [...openingDone(), row('regulatory', 'round2')];
    const server = [...local, row('clinical', 'round2', { text: null })];
    const stuck = server[server.length - 1];
    const ctx = loadHelpers({ running: false, messages: local, serverMessages: server });
    await ctx.resumeStalledMeeting();
    assert.deepEqual(ctx.calls.deletes, [{ method: 'DELETE', url: `/api/sessions/39/messages/${stuck.id}` }]);
    assert.deepEqual(plain(ctx.calls.runSequence), [[{ speaker: 'clinical', mode: 'round2' }, { speaker: 'commercial', mode: 'round2' }]]);
  });

  it('holds the controls during the reload, and abandons the resume if another evaluation was opened meanwhile', async () => {
    const ctx = loadHelpers({ running: false, messages: productionMessages() });
    const realGet = ctx.api.get;
    ctx.api.get = async (url) => {
      assert.equal(ctx.state.running, true, 'controls must be held while the reload is in flight');
      const r = await realGet(url);
      ctx.state.session = { id: 40, messages: [] };
      return r;
    };
    await ctx.resumeStalledMeeting();
    assert.equal(ctx.calls.confirms.length, 0);
    assert.equal(ctx.calls.deletes.length, 0);
    assert.equal(ctx.calls.runSequence.length, 0);
    assert.equal(ctx.state.running, false, 'controls released afterwards');
  });

  it('asks a second time before clearing an unfinished turn that may still be running, and stops if declined', async () => {
    const messages = [...openingDone(), row('regulatory', 'round2'), row('clinical', 'round2', { text: null, created_at: new Date().toISOString() })];
    const ctx = loadHelpers({ running: false, messages, confirmReturns: [true, false] });
    await ctx.resumeStalledMeeting();
    assert.equal(ctx.calls.confirms.length, 2);
    assert.match(ctx.calls.confirms[1], /may still be running/);
    assert.equal(ctx.calls.deletes.length, 0);
    assert.equal(ctx.calls.runSequence.length, 0);
  });

  it('does not ask the second time for an old unfinished row or a recent failed one', async () => {
    const messages = [...openingDone(), row('regulatory', 'round2'),
      row('clinical', 'round2', { text: null }),
      row('commercial', 'round2', { text: '', error: 'boom', created_at: new Date().toISOString() })];
    const ctx = loadHelpers({ running: false, messages, confirmReturns: [true, false] });
    await ctx.resumeStalledMeeting();
    assert.equal(ctx.calls.confirms.length, 1);
    assert.equal(ctx.calls.deletes.length, 2);
    assert.equal(ctx.calls.runSequence.length, 1);
  });

  it('toasts and does not delete when an earlier round is still unmet', async () => {
    // Baselines is missing commercial, but round2 already has a cut-off Luca
    // row, so stalledMeeting() still finds a round2 stall to report.
    const messages = [
      row('regulatory', 'opening'), row('clinical', 'opening'),
      row('regulatory', 'round2'), row('clinical', 'round2', { text: null }),
    ];
    const ctx = loadHelpers({ running: false, messages });
    assert.deepEqual(ctx.stalledMeeting().mode, 'round2');
    await ctx.resumeStalledMeeting();
    assert.equal(ctx.calls.deletes.length, 0);
    assert.equal(ctx.calls.runSequence.length, 0);
    assert.equal(ctx.calls.toasts.length, 1);
    assert.match(ctx.calls.toasts[0], /Run Baselines for all 3 agents before resuming Challenge/);
  });

  it('returns without deleting or running when confirm() is declined', async () => {
    const ctx = loadHelpers({ running: false, messages: productionMessages(), confirmReturns: false });
    await ctx.resumeStalledMeeting();
    assert.equal(ctx.calls.deletes.length, 0);
    assert.equal(ctx.calls.runSequence.length, 0);
    assert.equal(ctx.calls.toasts.length, 0);
  });

  it('once confirmed: deletes only the pending agents\' stuck round2 rows, not Ruth\'s finished one or the stray Baselines row, then runs clinical then commercial in order', async () => {
    const messages = productionMessages();
    const stuckRow = messages.find((m) => m.mode === 'round2' && m.speaker === 'clinical');
    const strayOpeningRow = messages.find((m) => m.mode === 'opening' && m.error);
    const ruthRound2Row = messages.find((m) => m.mode === 'round2' && m.speaker === 'regulatory');
    const ctx = loadHelpers({ running: false, messages, confirmReturns: true });

    await ctx.resumeStalledMeeting();

    assert.deepEqual(ctx.calls.deletes, [{ method: 'DELETE', url: `/api/sessions/39/messages/${stuckRow.id}` }]);
    assert.equal(ctx.state.session.messages.some((m) => m.id === stuckRow.id), false, 'the cut-off round2 row must be removed from local state');
    assert.equal(ctx.state.session.messages.some((m) => m.id === strayOpeningRow.id), true, 'the stray Baselines row must survive a round2 resume');
    assert.equal(ctx.state.session.messages.some((m) => m.id === ruthRound2Row.id), true, 'Ruth\'s finished round2 row must survive');
    assert.equal(ctx.calls.renderTranscript, 2, 'once for the reloaded copy, once after clearing');
    assert.deepEqual(plain(ctx.calls.runSequence), [[{ speaker: 'clinical', mode: 'round2' }, { speaker: 'commercial', mode: 'round2' }]]);
  });

  it('toasts and does not run the sequence when a DELETE fails', async () => {
    const ctx = loadHelpers({
      running: false,
      messages: productionMessages(),
      confirmReturns: true,
      deleteImpl: () => { throw new Error('db unreachable'); },
    });
    const before = [...ctx.state.session.messages];

    await ctx.resumeStalledMeeting();

    assert.equal(ctx.calls.runSequence.length, 0);
    assert.equal(ctx.calls.toasts.length, 1);
    assert.match(ctx.calls.toasts[0], /Could not clear the stuck turn: db unreachable/);
    assert.deepEqual(ctx.state.session.messages, before, 'nothing should be removed from local state on a failed delete');
  });
});
