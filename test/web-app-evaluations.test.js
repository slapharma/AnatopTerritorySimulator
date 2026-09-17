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
  constructor() { this._html = ''; this.textContent = ''; }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
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

  it('does not mutate state.sessions', () => {
    const sessions = [{ id: 1, title: 'A', has_decision: false, meetings_run: [] }];
    const snapshot = JSON.stringify(sessions);
    const { ctx } = load({ sessions });
    ctx.renderEvaluations();
    assert.equal(JSON.stringify(sessions), snapshot);
  });
});
