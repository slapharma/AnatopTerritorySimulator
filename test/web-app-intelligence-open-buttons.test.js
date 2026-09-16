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
// modal on click, via a data-msg attribute the click handler reads back with
// Number(). A row can only usefully do that once the message has actually
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
