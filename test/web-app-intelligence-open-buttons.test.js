'use strict';
// web/app.js is a browser IIFE, so (as in the other web/app.js vm tests)
// evaluate intelRow/intelMsgRow/renderIntelligenceBody in a vm context
// against a fake state and a fake body element that only needs an innerHTML
// setter — renderIntelligence() itself also wires up #tab-intelligence and
// its chip buttons via $/$$, which this test skips to keep the DOM stubbing
// light; renderIntelligenceBody is where the by-agent/by-meeting row
// filtering actually happens.
//
// Response rows in the By Agent / By Meeting cuts open the full message in a
// modal on click, via a data-msg attribute the click handler matches as a
// string. A row can only usefully do that once the message has actually
// finished (no error, text no longer null) — a turn still in flight, or one
// orphaned by a page reload mid-turn, has nothing to show yet.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const ALL = ['regulatory', 'clinical', 'commercial']; // Ruth, Luca, Charlie
const AGENT_LABEL = { regulatory: 'Ruth', clinical: 'Luca', commercial: 'Charlie', moderator: 'Moderator Assistant', user: 'Moderator (you)' };
const MODE_LABEL = { opening: 'Baselines', round2: 'Challenge' };

class FakeBody {
  set innerHTML(v) { this._html = v; }

  get innerHTML() { return this._html; }
}

function loadHelpers({
  messages = [], disagreements = [], meetingMinutes = [], intelCut = 'agent', autopilotRuns = [], questions = [],
} = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf('  function intelRow(href, title, meta)');
  const end = src.indexOf('  // Sends { round, label, anchor_message_id }');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did intelRow/renderIntelligenceBody move?');

  const ctx = {
    ALL,
    AGENT_LABEL,
    MODE_LABEL,
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    fmtTime: () => 'a time',
    // autopilotMeta is defined earlier in web/app.js, outside this slice —
    // reproduced verbatim (it just reads m.content_json.autopilot).
    autopilotMeta: (m) => { if (!m.content_json) return null; try { return JSON.parse(m.content_json).autopilot || null; } catch { return null; } },
    state: { intelCut, session: { messages, disagreements, meeting_minutes: meetingMinutes, autopilot_runs: autopilotRuns, questions } },
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\nthis.renderIntelligenceBody = renderIntelligenceBody;\nthis.conversationOf = conversationOf;`, ctx);
  return ctx;
}

let seq = 0;
const msg = (speaker, mode, extra = {}) => ({ id: ++seq, seq, role: 'agent', speaker, mode, text: 'answer', error: null, created_at: '2026-01-01T00:00:00Z', ...extra });
const dataMsgIds = (html) => [...html.matchAll(/class="intel-open" data-msg="(\d+)"/g)].map((m) => Number(m[1]));

describe('web/app.js renderIntelligenceBody — By Agent cut', () => {
  it('renders an .intel-open button for a finished message', () => {
    const m = msg('clinical', 'round2');
    const ctx = loadHelpers({ intelCut: 'agent', messages: [m] });
    const body = new FakeBody();

    ctx.renderIntelligenceBody(body);

    assert.deepEqual(dataMsgIds(body.innerHTML), [m.id]);
  });

  it('renders no .intel-open button for a message still in flight (text still null)', () => {
    const m = msg('clinical', 'round2', { text: null });
    const ctx = loadHelpers({ intelCut: 'agent', messages: [m] });
    const body = new FakeBody();

    ctx.renderIntelligenceBody(body);

    assert.deepEqual(dataMsgIds(body.innerHTML), []);
    assert.match(body.innerHTML, /No messages yet\./);
  });

  it('renders no .intel-open button for a message that errored', () => {
    const m = msg('clinical', 'round2', { error: 'boom', text: '' });
    const ctx = loadHelpers({ intelCut: 'agent', messages: [m] });
    const body = new FakeBody();

    ctx.renderIntelligenceBody(body);

    assert.deepEqual(dataMsgIds(body.innerHTML), []);
  });

  it('renders buttons for the finished messages only, alongside pending/errored ones', () => {
    const ok1 = msg('regulatory', 'opening');
    const pending = msg('clinical', 'opening', { text: null });
    const errored = msg('commercial', 'opening', { error: 'boom', text: '' });
    const ok2 = msg('regulatory', 'round2');
    const ctx = loadHelpers({ intelCut: 'agent', messages: [ok1, pending, errored, ok2] });
    const body = new FakeBody();

    ctx.renderIntelligenceBody(body);

    assert.deepEqual(dataMsgIds(body.innerHTML).sort(), [ok1.id, ok2.id].sort());
  });
});

describe('web/app.js renderIntelligenceBody — By Meeting cut', () => {
  it('renders an .intel-open button for a finished message', () => {
    const m = msg('clinical', 'round2');
    const ctx = loadHelpers({ intelCut: 'meeting', messages: [m] });
    const body = new FakeBody();

    ctx.renderIntelligenceBody(body);

    assert.deepEqual(dataMsgIds(body.innerHTML), [m.id]);
  });

  it('renders no .intel-open button for a message still in flight or errored', () => {
    const pending = msg('clinical', 'round2', { text: null });
    const errored = msg('commercial', 'round2', { error: 'boom', text: '' });
    const ctx = loadHelpers({ intelCut: 'meeting', messages: [pending, errored] });
    const body = new FakeBody();

    ctx.renderIntelligenceBody(body);

    assert.deepEqual(dataMsgIds(body.innerHTML), []);
    // The meeting group itself still renders — its mode is known even
    // though nothing in it has an openable row yet.
    assert.match(body.innerHTML, /intel-group/);
  });
});

// conversationOf names an Autopilot message after the conversation it belongs
// to (the question or disagreement it discussed, or which open panel debate),
// not after the engine that ran it — see the comment on conversationOf itself.
describe('web/app.js conversationOf', () => {
  it('for a non-autopilot message, keys and labels it by its mode', () => {
    const ctx = loadHelpers({});

    const c = ctx.conversationOf({ mode: 'round2' });

    // conversationOf's return object is built inside the vm context, a
    // different realm — round-trip through JSON before deepEqual.
    assert.deepEqual(JSON.parse(JSON.stringify(c)), { key: 'round2', label: 'Challenge' });
  });

  it('names a question-scoped Autopilot message after the asker and addressees', () => {
    const questions = [{ id: '5', asker: 'clinical', addressees: 'commercial,moderator' }];
    const ctx = loadHelpers({ questions });
    const m = { mode: 'autopilot', content_json: JSON.stringify({ autopilot: { run_id: 'r1', question_id: '5', cycle: 1 } }) };

    const c = ctx.conversationOf(m);

    assert.equal(c.key, 'autopilot:r1');
    assert.equal(c.label, 'Question discussion: Luca → Charlie, Moderator');
  });

  it('falls back to a bare "Question discussion" label when the question_id no longer matches a question', () => {
    const ctx = loadHelpers({ questions: [] });
    const m = { mode: 'autopilot', content_json: JSON.stringify({ autopilot: { run_id: 'r1', question_id: '999', cycle: 1 } }) };

    const c = ctx.conversationOf(m);

    assert.equal(c.label, 'Question discussion');
  });

  it('names a disagreement-scoped Autopilot message after the disagreement number and topic', () => {
    const autopilotRuns = [{ id: 'r2', scope: 'disagreement', disagreement_n: 3 }];
    const ctx = loadHelpers({ autopilotRuns, disagreements: [{ n: 3, topic: 'Pricing strategy' }] });
    const m = { mode: 'autopilot', content_json: JSON.stringify({ autopilot: { run_id: 'r2', cycle: 1 } }) };

    const c = ctx.conversationOf(m);

    assert.equal(c.key, 'autopilot:r2');
    assert.equal(c.label, 'Disagreement debate #3: Pricing strategy');
  });

  it('drops the topic from a disagreement-scoped label when no matching disagreement record exists', () => {
    const autopilotRuns = [{ id: 'r2', scope: 'disagreement', disagreement_n: 3 }];
    const ctx = loadHelpers({ autopilotRuns, disagreements: [] });
    const m = { mode: 'autopilot', content_json: JSON.stringify({ autopilot: { run_id: 'r2', cycle: 1 } }) };

    const c = ctx.conversationOf(m);

    assert.equal(c.label, 'Disagreement debate #3');
  });

  it('numbers plain panel debates in the order they appear among non-question/non-disagreement runs', () => {
    const autopilotRuns = [
      { id: 'r1', scope: 'question' }, // not counted — a different kind of run
      { id: 'r2' }, // panel debate #1
      { id: 'r3' }, // panel debate #2
    ];
    const ctx = loadHelpers({ autopilotRuns });

    const c2 = ctx.conversationOf({ mode: 'autopilot', content_json: JSON.stringify({ autopilot: { run_id: 'r2', cycle: 1 } }) });
    const c3 = ctx.conversationOf({ mode: 'autopilot', content_json: JSON.stringify({ autopilot: { run_id: 'r3', cycle: 1 } }) });

    assert.equal(c2.label, 'Panel debate 1');
    assert.equal(c3.label, 'Panel debate 2');
  });

  it('labels a plain "Panel debate" with no number when the run_id matches no known run', () => {
    const ctx = loadHelpers({ autopilotRuns: [] });
    const m = { mode: 'autopilot', content_json: JSON.stringify({ autopilot: { run_id: 'unknown-run', cycle: 1 } }) };

    const c = ctx.conversationOf(m);

    assert.equal(c.label, 'Panel debate');
  });
});

describe('web/app.js renderIntelligenceBody — By Meeting cut groups Autopilot messages per run', () => {
  it('groups two messages from the same question-discussion run together, and a message from a different run separately', () => {
    const questions = [
      { id: '5', asker: 'clinical', addressees: 'commercial' },
      { id: '6', asker: 'regulatory', addressees: 'commercial' },
    ];
    const m1 = msg('clinical', 'autopilot', { seq: 1, content_json: JSON.stringify({ autopilot: { run_id: 'runA', question_id: '5', cycle: 1 } }) });
    const m2 = msg('commercial', 'autopilot', { seq: 2, content_json: JSON.stringify({ autopilot: { run_id: 'runA', question_id: '5', cycle: 1 } }) });
    const m3 = msg('regulatory', 'autopilot', { seq: 3, content_json: JSON.stringify({ autopilot: { run_id: 'runB', question_id: '6', cycle: 1 } }) });
    const ctx = loadHelpers({ intelCut: 'meeting', messages: [m1, m2, m3], questions });
    const body = new FakeBody();

    ctx.renderIntelligenceBody(body);

    const groups = [...body.innerHTML.matchAll(/<div class="intel-group"><h4>([^<]*)<\/h4>((?:(?!<div class="intel-group">).)*)<\/div>/gs)];
    assert.equal(groups.length, 2, `expected 2 groups (one per run), got:\n${body.innerHTML}`);
    const byHeading = Object.fromEntries(groups.map((g) => [g[1], dataMsgIds(g[2])]));
    assert.deepEqual(byHeading['Question discussion: Luca → Charlie'].sort(), [m1.id, m2.id].sort());
    assert.deepEqual(byHeading['Question discussion: Ruth → Charlie'], [m3.id]);
  });
});

// renderIntelligence() wires each .intel-open button to open its message. In
// production messages.id is bigserial, and node-pg returns int8 as a string
// ("123"), so the lookup has to match string ids as well as the numbers a
// fake db hands out. Stubs $/$$ just enough to reach the click handler.
function loadClickHandler({ messages, intelCut = 'agent' }) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf('  // Client-only "cuts" through the transcript');
  const end = src.indexOf('  // Sends { round, label, anchor_message_id }');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did renderIntelligence move?');

  const opened = [];
  const box = { innerHTML: '' };
  const body = new FakeBody();
  let buttons = [];
  const ctx = {
    ALL,
    AGENT_LABEL,
    MODE_LABEL,
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    fmtTime: () => 'a time',
    state: { intelCut, session: { messages, disagreements: [], meeting_minutes: [] } },
    openMessageModal: (m, who) => opened.push({ m, who }),
    $: (sel) => (sel === '#tab-intelligence' ? box : sel === '#intel-body' ? body : null),
    $$: (sel) => {
      if (sel !== '.intel-open') return [];
      // Mirror the browser: dataset values are always strings.
      buttons = [...body.innerHTML.matchAll(/class="intel-open" data-msg="([^"]*)"/g)].map((mt) => ({
        dataset: { msg: mt[1] },
        addEventListener(type, fn) { if (type === 'click') this.click = fn; },
      }));
      return buttons;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\nthis.renderIntelligence = renderIntelligence;`, ctx);
  ctx.renderIntelligence();
  return { buttons, opened };
}

describe('web/app.js renderIntelligence — clicking a response row', () => {
  for (const [label, id] of [['string id, as node-pg returns bigserial', '4821'], ['numeric id', 4821]]) {
    it(`opens the message modal for a ${label}`, () => {
      const m = msg('clinical', 'round2', { id });
      const { buttons, opened } = loadClickHandler({ messages: [m] });
      assert.equal(buttons.length, 1);

      buttons[0].click();

      assert.equal(opened.length, 1, 'click did not open the message modal');
      assert.equal(opened[0].m, m);
      assert.equal(opened[0].who, 'clinical');
    });
  }
});
