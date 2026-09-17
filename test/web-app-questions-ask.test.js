'use strict';
// "Ask agents to answer…" on an Agent Questions card (web/app.js): any panel
// agent but the asker can be asked to answer the question outside a full
// discuss-to-resolution loop. Covers questionCardHtml's button text/labels
// and .qn-ask panel, questionAnswerInstruction's brief, and questionAction's
// 'ask'/'send-ask' handling — one custom turn per ticked agent, in order,
// followed by a quiet answered-check. As in the other web/app.js vm tests
// (see test/web-app-questions.test.js), the relevant section is sliced out of
// web/app.js by string markers and run in a vm context.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const ALL = ['regulatory', 'clinical', 'commercial']; // Ruth, Luca, Charlie
const AGENT_LABEL = { regulatory: 'Ruth', clinical: 'Luca', commercial: 'Charlie', moderator: 'Moderator Assistant' };
const MODE_LABEL = { opening: 'Baselines' };
const QUESTION_STATUS_LABEL = { open: 'Open', answered: 'Answered', resolved: 'Resolved', escalated: 'Escalated to moderator' };

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function agentChipHtml(key) { return `<span class="agent-chip" data-agent="${key}">${escapeHtml(AGENT_LABEL[key] || key)}</span>`; }

// A card-level fake element good enough to drive questionAction's DOM calls:
// $ / $$ resolve a selector against whichever fake "panel"/"checkbox list" the
// test wired up on the card, the same way the real card's innerHTML would.
class FakeCard {
  constructor() {
    this.dataset = {};
    this._subEls = {};
  }

  querySelector(sel) {
    if (!(sel in this._subEls)) this._subEls[sel] = { hidden: false, value: '', checked: false, focus() {} };
    return this._subEls[sel];
  }
}

// A box-level fake element (#tab-questions / #tab-escalations): only innerHTML
// (read for the filters-placement assertion) and a querySelector stub good
// enough for renderQuestions to wire its own buttons without throwing —
// wireQuestionCards's card-by-card wiring is exercised directly via
// questionAction in the describe blocks above, not through this box.
class FakeBox {
  constructor() { this._html = ''; this._subEls = {}; }

  get innerHTML() { return this._html; }

  set innerHTML(v) { this._html = v; }

  querySelector(sel) {
    if (!(sel in this._subEls)) this._subEls[sel] = { addEventListener() {}, hidden: false };
    return this._subEls[sel];
  }

  querySelectorAll() { return []; }
}

function loadHelpers({ questions = [], messages = [] } = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf('  // ---------------- agent questions ----------------');
  const end = src.indexOf('  async function generateMeetingMinutes(');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did the agent questions section move?');

  const calls = { apiSend: [], toasts: [], runSequence: [] };
  const elements = {
    '#tab-questions': new FakeBox(), '#count-questions': { textContent: '' },
    '#tab-escalations': new FakeBox(), '#count-escalations': { textContent: '', className: '' },
  };

  const ctx = {
    ALL, AGENT_LABEL, MODE_LABEL, QUESTION_STATUS_LABEL, LENGTH_LABELS: [],
    escapeHtml, agentChipHtml,
    // Word / PDF / Excel links beside each item (openItemModal and its route are tested elsewhere).
    itemDownloadsHtml: (kind, key) => `<span class="item-downloads" data-kind="${kind}" data-key="${key}"></span>`, openItemModal: () => {}, GRID_MODES: ['opening', 'round2', 'round3', 'crosstalk'],
    state: { questionFilter: 'all', session: { id: 39, questions: questions.slice(), messages: messages.slice() } },
    document: { createElement: () => ({}) },
    $: (sel, root) => (root ? root.querySelector(sel) : (elements[sel] || null)),
    $$: (sel, root) => (root && root._checked ? root._checked.map((v) => ({ value: v })) : []),
    toast: (msg) => calls.toasts.push(msg),
    openMessageModal: () => {},
    renderMinutes: () => {},
    messageElement: () => ({}),
    runSequence: async (turns) => calls.runSequence.push(turns),
    api: {
      send: async (method, url, body) => {
        calls.apiSend.push({ method, url, body });
        if (/\/check$/.test(url)) return { updated: 0, questions: ctx.state.session.questions };
        if (method === 'PATCH' && /\/questions\/[^/]+$/.test(url)) return { questions: ctx.state.session.questions, meeting_minutes: [] };
        return {};
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}
this.questionCardHtml = questionCardHtml;
this.questionAction = questionAction;
this.questionAskableAgents = questionAskableAgents;
this.questionAnswerInstruction = questionAnswerInstruction;
this.renderQuestions = renderQuestions;`, ctx);
  ctx.calls = calls;
  ctx.elements = elements;
  return ctx;
}

const openQ = (over = {}) => ({ id: '5', status: 'open', asker: 'clinical', addressees: 'commercial', text: 'What is the PAMI reimbursement timeline?', round: 'opening', message_id: '10', ...over });

describe('web/app.js questionCardHtml — status action buttons', () => {
  it('shows "Mark as Resolved" (data-qact="mark-resolved") and "Escalate to Moderator" for an open question', () => {
    const ctx = loadHelpers({});

    const html = ctx.questionCardHtml(openQ());

    assert.match(html, /data-qact="mark-resolved">Mark as Resolved</);
    assert.match(html, /data-qact="escalate">Escalate to Moderator</);
    assert.doesNotMatch(html, /data-qact="mark-answered"/);
  });
});

describe('web/app.js questionAction — mark-resolved', () => {
  it('sets status to "resolved" via setQuestionStatus (PATCH with status: resolved)', async () => {
    const q = openQ();
    const ctx = loadHelpers({ questions: [q] });
    const card = new FakeCard();

    await ctx.questionAction(q, 'mark-resolved', card);

    const patch = ctx.calls.apiSend.find((c) => c.method === 'PATCH' && /\/questions\/5$/.test(c.url));
    assert.ok(patch, 'PATCH /questions/5 was sent');
    assert.equal(patch.body.status, 'resolved');
  });
});

describe('web/app.js questionCardHtml — "Ask agents to answer…" and the .qn-ask panel', () => {
  it('shows the button and lists every panel agent except the asker', () => {
    const ctx = loadHelpers({});

    const html = ctx.questionCardHtml(openQ({ asker: 'clinical', addressees: 'commercial' }));

    assert.match(html, /data-qact="ask">Ask agents to answer…</);
    assert.match(html, /class="qn-ask" hidden/);
    // Every agent but the asker (clinical) is listed: regulatory, commercial.
    assert.match(html, /value="regulatory"/);
    assert.match(html, /value="commercial"/);
    assert.doesNotMatch(html, /value="clinical"/);
  });

  it('pre-ticks the question\'s agent addressees, leaving other askable agents unticked', () => {
    const ctx = loadHelpers({});

    // asker: clinical, addressed to commercial (a panel agent) and moderator.
    const html = ctx.questionCardHtml(openQ({ asker: 'clinical', addressees: 'commercial,moderator' }));

    assert.match(html, /<label><input type="checkbox" value="regulatory"> Ruth<\/label>/, 'regulatory (not addressed) starts unticked');
    assert.match(html, /<label><input type="checkbox" value="commercial" checked> Charlie<\/label>/, 'commercial (addressed) starts ticked');
  });

  it('ticks every askable agent when the question was put only to the moderator', () => {
    const ctx = loadHelpers({});

    const html = ctx.questionCardHtml(openQ({ asker: 'clinical', addressees: 'moderator' }));

    assert.match(html, /<label><input type="checkbox" value="regulatory" checked> Ruth<\/label>/);
    assert.match(html, /<label><input type="checkbox" value="commercial" checked> Charlie<\/label>/);
  });
});

describe('web/app.js questionCardHtml — "Ask agents to answer…" only appears for an open question', () => {
  for (const status of ['escalated', 'answered', 'resolved']) {
    it(`shows no "Ask agents to answer…" button and no .qn-ask panel for a "${status}" question`, () => {
      const ctx = loadHelpers({});

      const html = ctx.questionCardHtml(openQ({ status, asker: 'clinical', addressees: 'commercial' }));

      assert.doesNotMatch(html, /data-qact="ask"/);
      assert.doesNotMatch(html, /class="qn-ask"/);
    });
  }
});

describe('web/app.js questionAnswerInstruction', () => {
  it('includes the question text and the asker/addressee labels', () => {
    const ctx = loadHelpers({});
    const q = openQ({ asker: 'clinical', addressees: 'commercial,moderator', text: 'What is the PAMI reimbursement timeline?' });

    const out = ctx.questionAnswerInstruction(q);

    assert.ok(out.includes('What is the PAMI reimbursement timeline?'));
    assert.ok(out.includes('Luca'), 'names the asker');
    assert.ok(out.includes('Charlie'), 'names a panel addressee');
    assert.ok(out.includes('the Moderator'), 'names the moderator addressee');
  });

  it('falls back to "the panel" when addressees is empty', () => {
    const ctx = loadHelpers({});
    const q = openQ({ addressees: '' });

    const out = ctx.questionAnswerInstruction(q);

    assert.ok(out.includes('the panel'));
  });
});

describe('web/app.js questionAction — ask / send-ask', () => {
  it('"ask" toggles the .qn-ask panel\'s hidden flag', async () => {
    const q = openQ();
    const ctx = loadHelpers({ questions: [q] });
    const card = new FakeCard();
    card.querySelector('.qn-ask').hidden = true;

    await ctx.questionAction(q, 'ask', card);

    assert.equal(card.querySelector('.qn-ask').hidden, false);
  });

  it('"send-ask" runs runSequence with one custom turn per ticked agent, in order, then checks for answers quietly', async () => {
    const q = openQ({ asker: 'clinical', addressees: 'commercial' });
    const ctx = loadHelpers({ questions: [q] });
    const card = new FakeCard();
    // $$('.qn-ask input:checked', card) is called against the card itself.
    card._checked = ['regulatory', 'commercial']; // order as ticked/listed
    const panel = card.querySelector('.qn-ask');

    await ctx.questionAction(q, 'send-ask', card);

    assert.equal(ctx.calls.runSequence.length, 1);
    const turns = ctx.calls.runSequence[0];
    assert.deepEqual(turns.map((t) => t.speaker), ['regulatory', 'commercial']);
    for (const t of turns) {
      assert.equal(t.mode, 'custom');
      assert.equal(t.question_id, '5');
      assert.ok(t.instruction.includes(q.text));
    }
    assert.equal(panel.hidden, true, 'the panel closes once the run is kicked off');
    const check = ctx.calls.apiSend.find((c) => c.method === 'POST' && /\/questions\/check$/.test(c.url));
    assert.ok(check, 'checkAnsweredQuestions({quiet:true}) posts to the check endpoint');
  });

  it('"send-ask" skips the answered-check when runSequence resolves false (a stop or a failed turn)', async () => {
    const q = openQ({ asker: 'clinical', addressees: 'commercial' });
    const ctx = loadHelpers({ questions: [q] });
    ctx.runSequence = async (turns) => { ctx.calls.runSequence.push(turns); return false; };
    const card = new FakeCard();
    card._checked = ['regulatory'];

    await ctx.questionAction(q, 'send-ask', card);

    const check = ctx.calls.apiSend.find((c) => c.method === 'POST' && /\/questions\/check$/.test(c.url));
    assert.equal(check, undefined, 'checkAnsweredQuestions is not called when runSequence resolved false');
  });

  it('"send-ask" with no agents ticked toasts and runs nothing', async () => {
    const q = openQ();
    const ctx = loadHelpers({ questions: [q] });
    const card = new FakeCard();
    card._checked = [];

    await ctx.questionAction(q, 'send-ask', card);

    assert.equal(ctx.calls.runSequence.length, 0);
    assert.match(ctx.calls.toasts[0], /Pick at least one agent/);
    assert.equal(ctx.calls.apiSend.length, 0, 'no answered-check either, since nothing ran');
  });
});

describe('web/app.js renderQuestions — filter actions live inside .qn-filters, not a trailing .qn-footer', () => {
  it('places "Check for answers now" and "Rescan transcript" inside .qn-filters when questions exist', () => {
    const questions = [openQ()];
    const ctx = loadHelpers({ questions });

    ctx.renderQuestions();

    const html = ctx.elements['#tab-questions'].innerHTML;
    const filtersBlock = /<div class="qn-filters">([\s\S]*?)<\/div>\s*\n\s*(?:<div class="qn |$)/.exec(html);
    assert.ok(filtersBlock, 'a .qn-filters block was rendered');
    assert.match(filtersBlock[1], /id="btn-questions-check">Check for answers now<\/button>/);
    assert.match(filtersBlock[1], /id="btn-questions-scan">Rescan transcript<\/button>/);
    assert.doesNotMatch(html, /class="qn-footer"/, 'no trailing .qn-footer when questions exist');
  });
});
