'use strict';
// web/app.js is a browser IIFE, so (as in the other web/app.js vm tests)
// evaluate renderMinutes() in a vm context against a fake state/$/$$. A
// question-round minutes entry (round: 'question', written for an action on
// an Agent Question — see src/questions.js's questionMinutes) is a record of
// what happened, not minutes awaiting approval: renderMinutes must leave off
// its Approve button and Pending/Approved badge, and its "view in transcript"
// link reads differently from an ordinary meeting's "view meeting" link.
// $$ is stubbed to always return [] (as in the other renderMinutes-adjacent
// tests) — the three forEach loops it drives (rendering each card's markdown
// body, and wiring the toggle/approve click handlers) only ever look up
// elements without a root, so this keeps the fake DOM light while still
// exercising the innerHTML this function builds, which is where the
// question-entry markup actually differs.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');

class FakeElement {
  constructor() { this._html = ''; this.textContent = ''; }

  get innerHTML() { return this._html; }

  set innerHTML(v) { this._html = v; }
}

function loadRenderMinutes({ meetingMinutes = [], openMinutes } = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf('  function renderMinutes() {');
  const end = src.indexOf('  function renderIntelligence() {');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did renderMinutes move?');

  const elements = { '#count-minutes': new FakeElement(), '#tab-minutes': new FakeElement() };
  const ctx = {
    Set,
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    fmtTime: () => 'a time',
    renderMarkdown: () => ({}),
    toast: () => {},
    api: { send: async () => ({}) },
    state: { session: { meeting_minutes: meetingMinutes }, openMinutes },
    $: (sel, root) => (root ? null : (elements[sel] || null)),
    $$: () => [],
    // "Approve and continue" names the next meeting on the agenda.
    MODE_LABEL: { opening: 'Baselines', round2: 'Challenge', round3: 'Converge', crosstalk: 'Cross-talk' },
    nextMeeting: (m) => ({ opening: 'round2', round2: 'round3', round3: 'crosstalk' }[m] || null),
    startMeeting: () => {},
    // Word / PDF / Excel links beside each item (openItemModal and its route are tested elsewhere).
    itemDownloadsHtml: (kind, key) => `<span class="item-downloads" data-kind="${kind}" data-key="${key}"></span>`, openItemModal: () => {}, GRID_MODES: ['opening', 'round2', 'round3', 'crosstalk'],
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\nthis.renderMinutes = renderMinutes;`, ctx);
  ctx.elements = elements;
  return ctx;
}

const mm = (over = {}) => ({ id: 1, round: 'opening', label: 'Baselines minutes', text: 'text', created_at: '2026-01-01T00:00:00Z', approved: false, anchor_message_id: null, ...over });

describe('web/app.js renderMinutes', () => {
  it('shows the empty-state message and no list when there are no minutes yet', () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [] });

    ctx.renderMinutes();

    assert.match(ctx.elements['#tab-minutes'].innerHTML, /No minutes yet\./);
    assert.doesNotMatch(ctx.elements['#tab-minutes'].innerHTML, /<ol/);
  });

  it('sets the tab count to the number of minutes entries', () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 1 }), mm({ id: 2 })] });

    ctx.renderMinutes();

    assert.equal(ctx.elements['#count-minutes'].textContent, 2);
  });

  it('a normal meeting entry gets a Pending badge, an Approve button, and a "view meeting" link', () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 1, round: 'opening', approved: false, anchor_message_id: 42 })] });

    ctx.renderMinutes();

    const html = ctx.elements['#tab-minutes'].innerHTML;
    assert.match(html, /minutes-pending/);
    assert.match(html, /Pending/);
    assert.match(html, /class="btn btn-sm btn-accent minutes-approve"/);
    assert.match(html, /↑ view meeting/);
    assert.doesNotMatch(html, /minutes-question/);
  });

  it('an approved meeting entry shows "Approved" and no Approve button', () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 1, round: 'opening', approved: true })] });

    ctx.renderMinutes();

    const html = ctx.elements['#tab-minutes'].innerHTML;
    assert.match(html, /minutes-approved/);
    assert.match(html, />Approved</);
    assert.doesNotMatch(html, /class="btn btn-sm btn-accent minutes-approve"/);
  });

  it('a question-round entry has no Approve button and no Pending/Approved badge at all', () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 1, round: 'question', label: 'Question answered by the moderator · Luca → Charlie', anchor_message_id: 7 })] });

    ctx.renderMinutes();

    const html = ctx.elements['#tab-minutes'].innerHTML;
    assert.doesNotMatch(html, /minutes-pending/);
    assert.doesNotMatch(html, /minutes-approved/);
    assert.doesNotMatch(html, /minutes-approve/);
    assert.doesNotMatch(html, />Pending</);
    assert.doesNotMatch(html, />Approved</);
  });

  it('a question-round entry gets the "minutes-question" class and a "view in transcript" link', () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 1, round: 'question', anchor_message_id: 7 })] });

    ctx.renderMinutes();

    const html = ctx.elements['#tab-minutes'].innerHTML;
    assert.match(html, /class="minutes-card minutes-question"/);
    assert.match(html, /href="#msg-7" class="minutes-back">↑ view in transcript/);
    assert.doesNotMatch(html, /view meeting/);
  });

  it('renders no back-link at all when the entry has no anchor_message_id, question or not', () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 1, round: 'question', anchor_message_id: null })] });

    ctx.renderMinutes();

    assert.doesNotMatch(ctx.elements['#tab-minutes'].innerHTML, /minutes-back/);
  });

  it('an unapproved standard-meeting entry gets "Approve and continue" naming the next meeting on the agenda', () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 1, round: 'opening', approved: false })] });

    ctx.renderMinutes();

    const html = ctx.elements['#tab-minutes'].innerHTML;
    assert.match(html, /class="btn btn-sm btn-primary minutes-approve minutes-continue" data-next="round2"/);
    assert.match(html, />Approve and continue</);
  });

  for (const [round, next] of [['opening', 'round2'], ['round2', 'round3'], ['round3', 'crosstalk']]) {
    it(`names "${next}" as data-next for an unapproved "${round}" entry`, () => {
      const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 1, round, approved: false })] });

      ctx.renderMinutes();

      assert.match(ctx.elements['#tab-minutes'].innerHTML, new RegExp(`data-next="${next}"`));
    });
  }

  it('a pending crosstalk entry (last standard meeting) gets no "Approve and continue" — nothing follows it', () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 1, round: 'crosstalk', approved: false })] });

    ctx.renderMinutes();

    assert.doesNotMatch(ctx.elements['#tab-minutes'].innerHTML, /minutes-continue/);
  });

  it('an already-approved entry gets no "Approve and continue", even mid-agenda', () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 1, round: 'opening', approved: true })] });

    ctx.renderMinutes();

    assert.doesNotMatch(ctx.elements['#tab-minutes'].innerHTML, /minutes-continue/);
  });

  it('a question-round entry gets no "Approve and continue"', () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 1, round: 'question', approved: false })] });

    ctx.renderMinutes();

    assert.doesNotMatch(ctx.elements['#tab-minutes'].innerHTML, /minutes-continue/);
  });

  it('clicking "Approve and continue" approves, then starts the next meeting named on the button', async () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 1, round: 'opening', approved: false })] });
    const started = [];
    ctx.startMeeting = (mode) => started.push(mode);
    ctx.api.send = async () => ({ approved: true });
    const btn = {
      dataset: { next: 'round2' }, disabled: false,
      closest: () => ({ dataset: { id: '1' } }),
      addEventListener(type, fn) { if (type === 'click') this._click = fn; },
    };
    ctx.$$ = (sel) => (sel === '#tab-minutes .minutes-approve' ? [btn] : []);

    ctx.renderMinutes(); // wires btn._click
    await btn._click();

    assert.deepEqual(started, ['round2']);
    assert.equal(ctx.state.session.meeting_minutes[0].approved, true);
  });

  // FakeApproveButton stands in for the real anchor button, capturing whatever
  // click handler renderMinutes wires onto it via addEventListener, the same
  // way the "Approve and continue" test above does — but shared across the
  // group below since none of them read the button's rendered HTML.
  function makeApproveBtn(next) {
    return {
      dataset: next ? { next } : {}, disabled: false,
      closest: () => ({ dataset: { id: '1' } }),
      addEventListener(type, fn) { if (type === 'click') this._click = fn; },
    };
  }

  it('plain "Approve" (no data-next) never calls startMeeting', async () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 1, round: 'opening', approved: false })] });
    const started = [];
    ctx.startMeeting = (mode) => started.push(mode);
    ctx.api.send = async () => ({ approved: true });
    const btn = makeApproveBtn(null);
    ctx.$$ = (sel) => (sel === '#tab-minutes .minutes-approve' ? [btn] : []);

    ctx.renderMinutes();
    await btn._click();

    assert.deepEqual(started, []);
    assert.equal(ctx.state.session.meeting_minutes[0].approved, true);
  });

  it('when the approve PATCH itself fails, toasts "Could not approve: …", re-enables the button, and never calls startMeeting', async () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 1, round: 'opening', approved: false })] });
    const started = [];
    const toasts = [];
    ctx.startMeeting = (mode) => started.push(mode);
    ctx.toast = (msg) => toasts.push(msg);
    ctx.api.send = async () => { throw new Error('network down'); };
    const btn = makeApproveBtn('round2');
    ctx.$$ = (sel) => (sel === '#tab-minutes .minutes-approve' ? [btn] : []);

    ctx.renderMinutes();
    await btn._click();

    assert.deepEqual(toasts, ['Could not approve: network down']);
    assert.equal(started.length, 0, 'startMeeting is never called when the PATCH itself failed');
    assert.equal(btn.disabled, false, 'the button is re-enabled so the user can retry');
    assert.equal(ctx.state.session.meeting_minutes[0].approved, false, 'not marked approved locally');
  });

  it('when the PATCH succeeds but startMeeting(next) rejects, toasts "Could not start <label>: …", not "Could not approve"', async () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 1, round: 'opening', approved: false })] });
    const toasts = [];
    ctx.startMeeting = async () => { throw new Error('agent unavailable'); };
    ctx.toast = (msg) => toasts.push(msg);
    ctx.api.send = async () => ({ approved: true });
    const btn = makeApproveBtn('round2');
    ctx.$$ = (sel) => (sel === '#tab-minutes .minutes-approve' ? [btn] : []);

    ctx.renderMinutes();
    await btn._click();

    assert.deepEqual(toasts, ['Meeting approved.', 'Could not start Challenge: agent unavailable']);
    assert.equal(ctx.state.session.meeting_minutes[0].approved, true, 'the approval itself landed');
  });

  it('marks a card open — expanded, no [hidden] on its detail — when its id is in state.openMinutes', () => {
    const ctx = loadRenderMinutes({ meetingMinutes: [mm({ id: 5, round: 'question' })], openMinutes: new Set([5]) });

    ctx.renderMinutes();

    const html = ctx.elements['#tab-minutes'].innerHTML;
    assert.match(html, /class="minutes-card minutes-question open"/);
    assert.match(html, /aria-expanded="true"/);
    assert.doesNotMatch(html, /minutes-detail" hidden/);
  });
});
