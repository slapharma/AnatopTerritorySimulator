'use strict';
// web/app.js's new "All evaluations" page: meetingProgressHtml() (the four-dot
// meeting tracker) and renderEvaluations() (the filterable table, admin-only
// Spend column, empty/no-match states). Sliced out of web/app.js by string
// markers and run in a vm context, same approach as the other web/app.js vm
// tests (test/web-app-meeting-columns.test.js, test/web-app-power-nav.test.js)
// — GRID_MODES/MODE_LABEL/escapeHtml/isAdminUser/fmtTime/fmtRelative/$ are
// supplied on the context since the slice does not include their definitions.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const GRID_MODES = ['opening', 'round2', 'round3', 'crosstalk'];
const MODE_LABEL = { opening: 'Baselines', round2: 'Challenge', round3: 'Converge', crosstalk: 'Cross-talk' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class FakeElement {
  constructor() { this._html = ''; this.textContent = ''; this._listeners = {}; }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  addEventListener(type, fn) { this._listeners[type] = fn; }
}

function load({ sessions = [], evalsFilter = '', isAdmin = false } = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf('  // ---------------- all evaluations ----------------');
  const end = src.indexOf("  // Header power buttons, filled into every view's .power-nav.");
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did renderEvaluations/meetingProgressHtml move?');

  const page = { '#evals-sub': new FakeElement(), '#evals-table': new FakeElement() };
  const ctx = {
    state: { sessions, evalsFilter },
    GRID_MODES, MODE_LABEL, escapeHtml,
    isAdminUser: () => isAdmin,
    fmtTime: (utc) => `TIME(${utc})`,
    fmtRelative: (utc) => `REL(${utc})`,
    $: (sel) => { if (sel in page) return page[sel]; throw new Error(`unexpected $ selector: ${sel}`); },
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\nthis.meetingProgressHtml = meetingProgressHtml;\nthis.renderEvaluations = renderEvaluations;`, ctx);
  return { ctx, page };
}

// Sliced separately: the #evals-table click handler lives inside init(), far
// from the render code above, wired up via `$('#evals-table').addEventListener('click', ...)`.
// $ is mocked to return a FakeElement whose addEventListener just records the
// callback, so running this slice through vm attaches the handler to the fake
// element without needing a real DOM or the rest of init().
function loadClickHandler({ sessions = [], confirmReturn = true, sendImpl, loadSessionsImpl } = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf('    // A row opens its evaluation from anywhere on it; the title is the real');
  const end = src.indexOf('    // Same head component, same behaviour; this one starts open because the');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did the #evals-table click handler move?');

  const table = new FakeElement();
  const calls = { confirm: [], send: [], toast: [], loadSessions: 0, openSession: [] };
  const ctx = {
    state: { sessions },
    $: (sel) => { if (sel === '#evals-table') return table; throw new Error(`unexpected $ selector: ${sel}`); },
    confirm: (msg) => { calls.confirm.push(msg); return confirmReturn; },
    api: { send: sendImpl || (async (method, url) => { calls.send.push([method, url]); }) },
    toast: (msg) => { calls.toast.push(msg); },
    loadSessions: loadSessionsImpl || (async () => { calls.loadSessions += 1; }),
    openSession: (id) => { calls.openSession.push(id); },
    Number,
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end), ctx);
  return { clickHandler: table._listeners.click, calls };
}

// Minimal stand-in for the DOM element e.target would be: closest() returns
// itself when the selector matches one of the classes it carries.
function fakeTarget(matches, extra = {}) {
  return { dataset: {}, ...extra, closest(sel) { return matches.includes(sel) ? this : null; } };
}

describe('web/app.js #evals-table click handler', () => {
  it('does nothing when the delete confirmation is declined', async () => {
    const sessions = [{ id: 1, title: 'A' }];
    const { clickHandler, calls } = loadClickHandler({ sessions, confirmReturn: false });
    const btn = fakeTarget(['[data-delete]'], { dataset: { delete: '1' }, disabled: false });
    await clickHandler({ target: btn });
    assert.equal(calls.send.length, 0);
    assert.equal(calls.openSession.length, 0);
    assert.equal(btn.disabled, false);
  });

  it('deletes the session, toasts and reloads when confirmed', async () => {
    const sessions = [{ id: 1, title: 'A' }];
    const { clickHandler, calls } = loadClickHandler({ sessions, confirmReturn: true });
    const btn = fakeTarget(['[data-delete]'], { dataset: { delete: '1' }, disabled: false });
    await clickHandler({ target: btn });
    assert.deepEqual(calls.send, [['DELETE', '/api/sessions/1']]);
    assert.equal(calls.loadSessions, 1);
    assert.equal(calls.openSession.length, 0, 'deleting must not also open the row');
    assert.match(calls.toast[0], /Deleted "A"/);
  });

  it('re-enables the button and toasts an error when the delete fails', async () => {
    const sessions = [{ id: 1, title: 'A' }];
    const sendImpl = async () => { throw new Error('boom'); };
    const { clickHandler, calls } = loadClickHandler({ sessions, confirmReturn: true, sendImpl });
    const btn = fakeTarget(['[data-delete]'], { dataset: { delete: '1' }, disabled: false });
    await clickHandler({ target: btn });
    assert.equal(btn.disabled, false);
    assert.equal(calls.loadSessions, 0);
    assert.match(calls.toast[0], /Could not delete session: boom/);
  });

  it('opens the session when the click lands on a row without hitting delete', async () => {
    const sessions = [{ id: 1, title: 'A' }];
    const { clickHandler, calls } = loadClickHandler({ sessions });
    const row = fakeTarget(['[data-open]'], { dataset: { open: '1' } });
    await clickHandler({ target: row });
    assert.deepEqual(calls.openSession, [1]);
    assert.equal(calls.send.length, 0);
  });
});

describe('web/app.js meetingProgressHtml()', () => {
  it('shows "Not started" and zero dots lit for no meetings run', () => {
    const { ctx } = load();
    const html = ctx.meetingProgressHtml([]);
    assert.match(html, /aria-label="0 of 4 meetings held"/);
    assert.equal((html.match(/evals-step on/g) || []).length, 0);
    assert.match(html, /Not started/);
  });

  it('treats a missing/null run the same as an empty one', () => {
    const { ctx } = load();
    assert.equal(ctx.meetingProgressHtml(undefined), ctx.meetingProgressHtml([]));
    assert.equal(ctx.meetingProgressHtml(null), ctx.meetingProgressHtml([]));
  });

  it('lights exactly the held steps and labels the last one held, in meeting order — not array order', () => {
    const { ctx } = load();
    // round3 appears before opening in the input array; the label must still
    // follow GRID_MODES order (round3 is later in the sequence) and read
    // "Converge", not "Baselines".
    const html = ctx.meetingProgressHtml(['round3', 'opening']);
    assert.match(html, /aria-label="2 of 4 meetings held"/);
    assert.equal((html.match(/evals-step on/g) || []).length, 2);
    assert.match(html, /Converge/);
    assert.doesNotMatch(html, /evals-progress-label">Baselines/);
  });

  it('every meeting held reports all four dots lit and the final meeting as the label', () => {
    const { ctx } = load();
    const html = ctx.meetingProgressHtml(GRID_MODES.slice());
    assert.match(html, /aria-label="4 of 4 meetings held"/);
    assert.equal((html.match(/evals-step on/g) || []).length, 4);
    assert.match(html, /Cross-talk/);
  });

  it('ignores a mode that is not one of the four meetings, so the count agrees with the dots', () => {
    const { ctx } = load();
    const html = ctx.meetingProgressHtml(['some_unknown_mode', 'opening']);
    assert.match(html, /aria-label="1 of 4 meetings held"/);
    assert.equal((html.match(/evals-step on/g) || []).length, 1);
    assert.match(html, /Baselines/);
  });
});

describe('web/app.js renderEvaluations()', () => {
  it('shows the empty-register state and an empty subtitle when there are no sessions', () => {
    const { ctx, page } = load({ sessions: [] });
    ctx.renderEvaluations();
    assert.match(page['#evals-table'].innerHTML, /No evaluations yet\./);
    assert.equal(page['#evals-sub'].textContent, '');
  });

  it('summarises count and decided count in the subtitle', () => {
    const sessions = [
      { id: 1, title: 'A', has_decision: true, meetings_run: [] },
      { id: 2, title: 'B', has_decision: false, meetings_run: [] },
    ];
    const { ctx, page } = load({ sessions });
    ctx.renderEvaluations();
    assert.equal(page['#evals-sub'].textContent, '2 on record · 1 with a board decision · most recent first');
  });

  it('shows a no-match state (with the filter text escaped) when the filter matches nothing, without touching the subtitle', () => {
    const sessions = [{ id: 1, title: 'Anatop Argentina', product: 'Anatop', country: 'Argentina', has_decision: false, meetings_run: [] }];
    const { ctx, page } = load({ sessions, evalsFilter: '<script>nope' });
    ctx.renderEvaluations();
    assert.match(page['#evals-table'].innerHTML, /No evaluation matches/);
    assert.match(page['#evals-table'].innerHTML, /&lt;script&gt;nope/);
    assert.doesNotMatch(page['#evals-table'].innerHTML, /<script>/);
  });

  it('filters case-insensitively across title, product and country', () => {
    const sessions = [
      { id: 1, title: 'Anatop Argentina', product: 'Anatop', country: 'Argentina', has_decision: false, meetings_run: [] },
      { id: 2, title: 'Other Evaluation', product: 'Widget', country: 'France', has_decision: false, meetings_run: [] },
    ];
    const { ctx, page } = load({ sessions, evalsFilter: 'ARGENT' });
    ctx.renderEvaluations();
    assert.match(page['#evals-table'].innerHTML, /Anatop Argentina/);
    assert.doesNotMatch(page['#evals-table'].innerHTML, /Other Evaluation/);
  });

  it('escapes a session title against injected markup', () => {
    const sessions = [{ id: 1, title: '<img src=x onerror=alert(1)>', has_decision: false, meetings_run: [] }];
    const { ctx, page } = load({ sessions });
    ctx.renderEvaluations();
    assert.doesNotMatch(page['#evals-table'].innerHTML, /<img src=x/);
    assert.match(page['#evals-table'].innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it('includes the Spend column and per-row cost for an admin user', () => {
    const sessions = [{ id: 1, title: 'A', has_decision: false, meetings_run: [], cost_usd: 12.345 }];
    const { ctx, page } = load({ sessions, isAdmin: true });
    ctx.renderEvaluations();
    assert.match(page['#evals-table'].innerHTML, /<th scope="col" class="num">Spend<\/th>/);
    assert.match(page['#evals-table'].innerHTML, /\$12\.35/);
  });

  it('omits the Spend column entirely for a non-admin user', () => {
    const sessions = [{ id: 1, title: 'A', has_decision: false, meetings_run: [], cost_usd: 12.345 }];
    const { ctx, page } = load({ sessions, isAdmin: false });
    ctx.renderEvaluations();
    assert.doesNotMatch(page['#evals-table'].innerHTML, /Spend/);
    assert.doesNotMatch(page['#evals-table'].innerHTML, /\$12\.35/);
  });

  it('flags open disagreements and escalated questions, pluralising exactly one disagreement', () => {
    const sessions = [{ id: 1, title: 'A', has_decision: false, meetings_run: [], open_disagreements: 1, escalated_questions: 3 }];
    const { ctx, page } = load({ sessions });
    ctx.renderEvaluations();
    assert.match(page['#evals-table'].innerHTML, /1 open disagreement</, 'singular, not "1 open disagreements"');
    assert.match(page['#evals-table'].innerHTML, /3 escalated/);
  });

  it('pluralises two or more open disagreements', () => {
    const sessions = [{ id: 1, title: 'A', has_decision: false, meetings_run: [], open_disagreements: 2, escalated_questions: 0 }];
    const { ctx, page } = load({ sessions });
    ctx.renderEvaluations();
    assert.match(page['#evals-table'].innerHTML, /2 open disagreements</);
  });

  it('shows the "no attention needed" placeholder when there is nothing to flag', () => {
    const sessions = [{ id: 1, title: 'A', has_decision: false, meetings_run: [], open_disagreements: 0, escalated_questions: 0 }];
    const { ctx, page } = load({ sessions });
    ctx.renderEvaluations();
    assert.match(page['#evals-table'].innerHTML, /evals-none">—</);
  });

  it('renders a delete button per row with the session id and an aria-label carrying the escaped title', () => {
    const sessions = [
      { id: 7, title: 'Anatop <Korea>', has_decision: false, meetings_run: [] },
      { id: 9, title: 'B', has_decision: false, meetings_run: [] },
    ];
    const { ctx, page } = load({ sessions });
    ctx.renderEvaluations();
    const html = page['#evals-table'].innerHTML;
    assert.match(html, /class="btn btn-sm btn-danger-ghost evals-delete" data-delete="7" aria-label="Delete Anatop &lt;Korea&gt;"/);
    assert.match(html, /class="btn btn-sm btn-danger-ghost evals-delete" data-delete="9" aria-label="Delete B"/);
    assert.doesNotMatch(html, /Delete Anatop <Korea>/, 'title must be escaped inside the aria-label');
  });

  it('gives every row the same number of cells as there are header columns, for an admin user', () => {
    const sessions = [{ id: 1, title: 'A', has_decision: false, meetings_run: [], cost_usd: 1 }];
    const { ctx, page } = load({ sessions, isAdmin: true });
    ctx.renderEvaluations();
    const html = page['#evals-table'].innerHTML;
    const headerCount = (html.match(/<th scope="col"/g) || []).length;
    const rowCellCount = (html.match(/<td/g) || []).length + 1; // +1 for the <th scope="row"> title cell
    assert.equal(headerCount, rowCellCount);
  });

  it('gives every row the same number of cells as there are header columns, for a non-admin user', () => {
    const sessions = [{ id: 1, title: 'A', has_decision: false, meetings_run: [], cost_usd: 1 }];
    const { ctx, page } = load({ sessions, isAdmin: false });
    ctx.renderEvaluations();
    const html = page['#evals-table'].innerHTML;
    const headerCount = (html.match(/<th scope="col"/g) || []).length;
    const rowCellCount = (html.match(/<td/g) || []).length + 1;
    assert.equal(headerCount, rowCellCount);
  });

  it('does not mutate state.sessions', () => {
    const sessions = [{ id: 1, title: 'A', has_decision: false, meetings_run: [] }];
    const snapshot = JSON.stringify(sessions);
    const { ctx } = load({ sessions });
    ctx.renderEvaluations();
    assert.equal(JSON.stringify(sessions), snapshot);
  });
});
