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

function loadHelpers({ messages = [], disagreements = [], meetingMinutes = [], intelCut = 'agent' } = {}) {
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
    state: { intelCut, session: { messages, disagreements, meeting_minutes: meetingMinutes } },
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\nthis.renderIntelligenceBody = renderIntelligenceBody;`, ctx);
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
