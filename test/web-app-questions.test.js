'use strict';
// web/app.js is a browser IIFE, so (as in the other web/app.js vm tests)
// evaluate the Agent Questions helpers and runAutopilot's question scope in a
// vm context, with api/toast/runTurn/document stubbed the way the app itself
// calls them.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const ALL = ['regulatory', 'clinical', 'commercial']; // Ruth, Luca, Charlie
const GRID_MODES = ['opening', 'round2', 'round3', 'crosstalk'];
const AGENT_LABEL = { regulatory: 'Ruth', clinical: 'Luca', commercial: 'Charlie', moderator: 'Moderator Assistant' };
const MODE_LABEL = { opening: 'Baselines', round2: 'Challenge', round3: 'Converge', crosstalk: 'Cross-talk' };
const QUESTION_STATUS_LABEL = { open: 'Open', answered: 'Answered', resolved: 'Resolved', escalated: 'Escalated to moderator' };
const LENGTH_LABELS = ['300 characters', '600 characters', '1,200 characters', '2,500 characters', 'As required'];

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function agentChipHtml(key) { return `<span class="agent-chip" data-agent="${key}">${escapeHtml(AGENT_LABEL[key] || key)}</span>`; }

// Minimal fake element: enough for renderQuestions/runAutopilot to build and
// stash HTML/children without a real DOM. querySelector(All) always misses,
// which is fine — every test here reads assertions off innerHTML or off the
// recorded calls, never off re-querying rendered markup.
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this._classes = [];
    this.dataset = {};
    this.children = [];
    this._html = '';
    this.textContent = '';
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }

  get className() { return this._classes.join(' '); }

  set className(v) { this._classes = String(v).split(/\s+/).filter(Boolean); }

  get classList() { const self = this; return { contains: (c) => self._classes.includes(c) }; }

  appendChild(el) { this.children.push(el); return el; }

  get innerHTML() { return this._html; }

  set innerHTML(v) { this._html = v; this.children = []; }

  // Real querySelector would find real nodes parsed out of innerHTML; these
  // fakes never parse it, so return a fresh throwaway element instead of null
  // — renderQuestions unconditionally wires listeners onto what it finds, and
  // a null here would fail on .addEventListener before a test's assertion
  // ever runs. Tests read the DOM through .innerHTML, not by re-querying it.
  querySelector() { return new FakeElement('div'); }

  querySelectorAll() { return []; }

  addEventListener() {}

  remove() {}

  focus() {}
}

// ---------------- renderQuestions / questionCardHtml / settleQuestionAfterDiscussion ----------------

function loadQuestionsHelpers({ questions = [], messages = [], questionFilter } = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf('  // ---------------- agent questions ----------------');
  const end = src.indexOf('  async function generateMeetingMinutes(');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did the agent questions section move?');

  const calls = { apiSend: [], toasts: [], runSequence: [] };
  const elements = { '#tab-questions': new FakeElement('div'), '#count-questions': new FakeElement('span') };

  const ctx = {
    ALL, AGENT_LABEL, MODE_LABEL, QUESTION_STATUS_LABEL, LENGTH_LABELS,
    escapeHtml, agentChipHtml,
    state: { questionFilter, session: { id: 39, questions: questions.slice(), messages: messages.slice() } },
    document: { createElement: (tag) => new FakeElement(tag) },
    $: (sel, root) => (root ? root.querySelector(sel) : (elements[sel] || null)),
    $$: (sel, root) => (root ? root.querySelectorAll(sel) : []),
    toast: (msg) => calls.toasts.push(msg),
    openMessageModal: () => {},
    messageElement: () => new FakeElement('div'),
    runSequence: async (turns) => calls.runSequence.push(turns),
    api: {
      send: async (method, url, body) => {
        calls.apiSend.push({ method, url, body });
        if (/\/check$/.test(url)) return { updated: 0, questions: ctx.state.session.questions };
        if (method === 'PATCH' && /\/questions\/[^/]+$/.test(url)) return ctx.state.session.questions;
        if (/\/answer$/.test(url)) return { message: {}, questions: ctx.state.session.questions, respondents: [] };
        return {};
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}
this.renderQuestions = renderQuestions;
this.questionCardHtml = questionCardHtml;
this.settleQuestionAfterDiscussion = settleQuestionAfterDiscussion;
this.setQuestionStatus = setQuestionStatus;
this.questionAgentAddressees = questionAgentAddressees;`, ctx);
  ctx.calls = calls;
  ctx.elements = elements;
  return ctx;
}

describe('web/app.js renderQuestions', () => {
  it('the tab badge shows open+escalated over the total', () => {
    const questions = [
      { id: '1', status: 'open', asker: 'regulatory', addressees: 'clinical', text: 'Q1', round: 'opening', message_id: '10' },
      { id: '2', status: 'escalated', asker: 'clinical', addressees: 'commercial', text: 'Q2', round: 'opening', message_id: '11' },
      { id: '3', status: 'answered', asker: 'commercial', addressees: 'regulatory', text: 'Q3', round: 'opening', message_id: '12' },
    ];
    const ctx = loadQuestionsHelpers({ questions });

    ctx.renderQuestions();

    assert.equal(ctx.elements['#count-questions'].textContent, '2/3');
  });

  it('shows 0 in the badge when there are no questions at all', () => {
    const ctx = loadQuestionsHelpers({ questions: [] });

    ctx.renderQuestions();

    assert.equal(ctx.elements['#count-questions'].textContent, '0');
  });

  it('defaults to the open filter and shows only open questions', () => {
    const questions = [
      { id: '1', status: 'open', asker: 'regulatory', addressees: 'clinical', text: 'Open one', round: 'opening', message_id: '10' },
      { id: '2', status: 'answered', asker: 'clinical', addressees: 'commercial', text: 'Answered one', round: 'opening', message_id: '11' },
    ];
    const ctx = loadQuestionsHelpers({ questions });

    ctx.renderQuestions();

    const html = ctx.elements['#tab-questions'].innerHTML;
    assert.match(html, /Open one/);
    assert.doesNotMatch(html, /Answered one/);
  });

  it('the "done" filter shows both answered and resolved questions, but not open ones', () => {
    const questions = [
      { id: '1', status: 'answered', asker: 'regulatory', addressees: 'clinical', text: 'Answered one', round: 'opening', message_id: '10' },
      { id: '2', status: 'resolved', asker: 'clinical', addressees: 'commercial', text: 'Resolved one', round: 'opening', message_id: '11' },
      { id: '3', status: 'open', asker: 'commercial', addressees: 'regulatory', text: 'Open one', round: 'opening', message_id: '12' },
    ];
    const ctx = loadQuestionsHelpers({ questions, questionFilter: 'done' });

    ctx.renderQuestions();

    const html = ctx.elements['#tab-questions'].innerHTML;
    assert.match(html, /Answered one/);
    assert.match(html, /Resolved one/);
    assert.doesNotMatch(html, /Open one/);
  });

  it('the "all" filter shows every question regardless of status', () => {
    const questions = [
      { id: '1', status: 'open', asker: 'regulatory', addressees: 'clinical', text: 'Open one', round: 'opening', message_id: '10' },
      { id: '2', status: 'escalated', asker: 'clinical', addressees: 'commercial', text: 'Escalated one', round: 'opening', message_id: '11' },
    ];
    const ctx = loadQuestionsHelpers({ questions, questionFilter: 'all' });

    ctx.renderQuestions();

    const html = ctx.elements['#tab-questions'].innerHTML;
    assert.match(html, /Open one/);
    assert.match(html, /Escalated one/);
  });
});

describe('web/app.js questionCardHtml — the Discuss action', () => {
  it('shows Discuss when the asker is a panel agent and another panel agent was addressed', () => {
    const ctx = loadQuestionsHelpers({});
    const qRow = { id: '1', status: 'open', asker: 'regulatory', addressees: 'clinical,moderator', text: 'Q', round: 'opening', message_id: '10' };

    const html = ctx.questionCardHtml(qRow);

    assert.match(html, /data-qact="discuss"/);
  });

  it('hides Discuss when the asker is the Moderator, not a panel agent', () => {
    const ctx = loadQuestionsHelpers({});
    const qRow = { id: '1', status: 'open', asker: 'moderator', addressees: 'clinical', text: 'Q', round: 'opening', message_id: '10' };

    const html = ctx.questionCardHtml(qRow);

    assert.doesNotMatch(html, /data-qact="discuss"/);
  });

  it('hides Discuss when the only addressee is the Moderator (no agent to discuss with)', () => {
    const ctx = loadQuestionsHelpers({});
    const qRow = { id: '1', status: 'open', asker: 'regulatory', addressees: 'moderator', text: 'Q', round: 'opening', message_id: '10' };

    const html = ctx.questionCardHtml(qRow);

    assert.doesNotMatch(html, /data-qact="discuss"/);
  });

  it('hides Discuss when the addressee list, after dropping the asker, is empty', () => {
    const ctx = loadQuestionsHelpers({});
    // Not a shape parseQuestions would produce (it excludes the asker itself),
    // but questionAgentAddressees is the guard against it reaching this far.
    const qRow = { id: '1', status: 'open', asker: 'regulatory', addressees: 'regulatory', text: 'Q', round: 'opening', message_id: '10' };

    const html = ctx.questionCardHtml(qRow);

    assert.doesNotMatch(html, /data-qact="discuss"/);
  });
});

describe('web/app.js settleQuestionAfterDiscussion', () => {
  const baseQuestion = { id: '5', status: 'open', asker: 'clinical', addressees: 'commercial', text: 'Q', round: 'opening', message_id: '10' };

  it('marks the question resolved, carrying the resolving message id, when the asker settled it', async () => {
    const ctx = loadQuestionsHelpers({ questions: [baseQuestion] });
    const resolvedMsg = { id: '77' };

    await ctx.settleQuestionAfterDiscussion({ question_id: '5' }, 'resolved', 2, resolvedMsg);

    const patch = ctx.calls.apiSend.find((c) => c.method === 'PATCH' && /\/questions\/5$/.test(c.url));
    assert.ok(patch, 'PATCH /questions/5 was sent');
    assert.equal(patch.body.status, 'resolved');
    assert.equal(patch.body.answer_message_id, '77');
    assert.match(ctx.calls.toasts[0], /resolved/i);
  });

  for (const outcome of ['cycle_cap', 'safety_cap', 'cost_cap']) {
    it(`escalates the question when the discussion stopped on ${outcome}`, async () => {
      const ctx = loadQuestionsHelpers({ questions: [baseQuestion] });

      await ctx.settleQuestionAfterDiscussion({ question_id: '5' }, outcome, 3, null);

      const patch = ctx.calls.apiSend.find((c) => c.method === 'PATCH' && /\/questions\/5$/.test(c.url));
      assert.ok(patch, 'PATCH /questions/5 was sent');
      assert.equal(patch.body.status, 'escalated');
    });
  }

  for (const outcome of ['failed', 'stopped_by_moderator']) {
    it(`leaves the question untouched when the discussion stopped on ${outcome}`, async () => {
      const ctx = loadQuestionsHelpers({ questions: [baseQuestion] });

      await ctx.settleQuestionAfterDiscussion({ question_id: '5' }, outcome, 1, null);

      assert.equal(ctx.calls.apiSend.length, 0);
      assert.equal(ctx.calls.toasts.length, 0);
    });
  }

  it('does nothing when settings.question_id no longer matches a question on the session', async () => {
    const ctx = loadQuestionsHelpers({ questions: [baseQuestion] });

    await ctx.settleQuestionAfterDiscussion({ question_id: 'missing' }, 'resolved', 1, { id: '1' });

    assert.equal(ctx.calls.apiSend.length, 0);
  });
});

// ---------------- runAutopilot — question scope ----------------

function loadAutopilotHelpers({ questions = [], runTurnImpl, autopilotRunResponse = { id: 'run-1' } } = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const qStart = src.indexOf('  // ---------------- agent questions ----------------');
  const qEnd = src.indexOf('  async function generateMeetingMinutes(');
  const apStart = src.indexOf('  // ---------------- autopilot ----------------');
  const apEnd = src.indexOf('  function autopilotStanceRows(');
  assert.ok(qStart >= 0 && qEnd > qStart, 'agent questions markers not found in web/app.js');
  assert.ok(apStart >= 0 && apEnd > apStart, 'autopilot markers not found in web/app.js — did runAutopilot move?');

  const t = new FakeElement('div');
  const elements = { '#transcript': t };
  const calls = { apiSend: [], toasts: [], runTurn: [], setRunning: [], renderDisagreements: 0, renderCost: 0, loadSessions: 0 };

  const ctx = {
    ALL, AGENT_LABEL, MODE_LABEL, QUESTION_STATUS_LABEL, LENGTH_LABELS,
    escapeHtml, agentChipHtml,
    AUTOPILOT_OUTCOME_LABEL: {
      stopped_by_moderator: 'Stopped by the moderator', failed: 'A turn failed', unanimous: 'All agents reached AGREE',
      cost_cap: 'Cost cap reached', cycle_cap: 'Cycle limit reached', safety_cap: 'Safety cycle cap reached',
      resolved: 'The asker marked the question resolved',
    },
    parsePosition: (text) => { const m = /POSITION:\s*(AGREE|DISAGREE)\b/i.exec(text || ''); return m ? m[1].toUpperCase() : null; },
    parseQuestionStatus: (text) => { const m = /QUESTION STATUS:\s*\**\s*(RESOLVED|OPEN)\b/i.exec(text || ''); return m ? m[1].toUpperCase() : null; },
    state: {
      session: { id: 39, questions: questions.slice(), messages: [] },
      config: { autopilot: { max_cycles: 20, max_cost_usd: 100 } },
      stopRequested: false,
    },
    document: { createElement: (tag) => new FakeElement(tag) },
    $: (sel, root) => (root ? root.querySelector(sel) : (elements[sel] || null)),
    $$: () => [],
    toast: (msg) => calls.toasts.push(msg),
    messageElement: () => new FakeElement('div'),
    setRunning: (v) => calls.setRunning.push(v),
    renderDisagreements: () => { calls.renderDisagreements += 1; },
    renderCost: () => { calls.renderCost += 1; },
    loadSessions: () => { calls.loadSessions += 1; },
    runTurn: async (turn) => {
      calls.runTurn.push(turn);
      const result = runTurnImpl ? runTurnImpl(turn, calls.runTurn.length) : 'answer';
      if (result === false) return false;
      ctx.state.session.messages.push({ id: String(calls.runTurn.length), speaker: turn.speaker, text: result, cost_usd: 0.01 });
      return true;
    },
    api: {
      send: async (method, url, body) => {
        calls.apiSend.push({ method, url, body });
        if (method === 'POST' && /\/autopilot-runs$/.test(url)) return autopilotRunResponse;
        if (method === 'PATCH' && /\/autopilot-runs\//.test(url)) return {};
        if (method === 'POST' && /\/system-note$/.test(url)) return { id: 'note', speaker: 'autopilot', text: body.text };
        if (method === 'PATCH' && /\/questions\//.test(url)) return ctx.state.session.questions;
        return {};
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(qStart, qEnd)}\n${src.slice(apStart, apEnd)}\nthis.runAutopilot = runAutopilot;`, ctx);
  ctx.calls = calls;
  ctx.t = t;
  return ctx;
}

describe('web/app.js runAutopilot — question scope', () => {
  it('keeps a fixed speaking order across loops and stops only when the asker resolves it, ignoring the same wording from an addressee', async () => {
    const ctx = loadAutopilotHelpers({
      questions: [{ id: '5', status: 'open', asker: 'clinical', addressees: 'commercial', text: 'Q', round: 'opening', message_id: '1' }],
      // commercial (the addressee) always writes a RESOLVED-looking line — this
      // must never be what stops the loop, only clinical's (the asker's) does.
      runTurnImpl: (turn, n) => {
        if (turn.speaker === 'clinical') return n <= 2 ? 'QUESTION STATUS: OPEN — still unclear.' : 'QUESTION STATUS: RESOLVED — got it.';
        return 'QUESTION STATUS: RESOLVED — addressee trying to trip the stop check.';
      },
    });
    const settings = {
      scope: 'question', question_id: '5', asker: 'clinical',
      agents: ['commercial', 'clinical'], max_chars: 600, interactions: 5,
      stopOnUnanimous: false, autoResolve: false, stances: {},
    };

    await ctx.runAutopilot(settings);

    const speakers = ctx.calls.runTurn.map((c) => c.speaker);
    // Loop 1: commercial, clinical (still open). Loop 2: commercial, clinical
    // (resolved) — same order both loops, and it stops right there.
    assert.deepEqual(speakers, ['commercial', 'clinical', 'commercial', 'clinical']);
    const patch = ctx.calls.apiSend.find((c) => c.method === 'PATCH' && /\/questions\/5$/.test(c.url));
    assert.equal(patch.body.status, 'resolved');
  });

  it('ignores stopOnUnanimous even when every reply carries POSITION: AGREE', async () => {
    const ctx = loadAutopilotHelpers({
      questions: [{ id: '5', status: 'open', asker: 'clinical', addressees: 'commercial', text: 'Q', round: 'opening', message_id: '1' }],
      runTurnImpl: () => 'POSITION: AGREE — sure.\nQUESTION STATUS: OPEN — never resolved in this test.',
    });
    const settings = {
      scope: 'question', question_id: '5', asker: 'clinical',
      agents: ['commercial', 'clinical'], max_chars: 600, interactions: 3,
      stopOnUnanimous: true, autoResolve: false, stances: {},
    };

    await ctx.runAutopilot(settings);

    // 3 loops x 2 speakers = 6 turns; a disagreement-scope run would have
    // stopped after loop 1 on stopOnUnanimous, a question-scope run must not.
    assert.equal(ctx.calls.runTurn.length, 6);
    const patch = ctx.calls.apiSend.find((c) => c.method === 'PATCH' && /\/questions\/5$/.test(c.url));
    assert.equal(patch.body.status, 'escalated', 'ran out of loops without resolving, so escalated — not silently dropped as unanimous');
  });

  it('runs no turns and toasts when starting the autopilot run does not come back with an id', async () => {
    const ctx = loadAutopilotHelpers({
      questions: [{ id: '5', status: 'open', asker: 'clinical', addressees: 'commercial', text: 'Q', round: 'opening', message_id: '1' }],
      autopilotRunResponse: {}, // no id
    });
    const settings = {
      scope: 'question', question_id: '5', asker: 'clinical',
      agents: ['commercial', 'clinical'], max_chars: 600, interactions: 3,
      stopOnUnanimous: false, autoResolve: false, stances: {},
    };

    await ctx.runAutopilot(settings);

    assert.equal(ctx.calls.runTurn.length, 0);
    assert.match(ctx.calls.toasts[0], /Could not start autopilot/);
    assert.deepEqual(ctx.calls.setRunning, [true, false]);
  });
});

// ---------------- writeMinutesIfComplete calls checkAnsweredQuestions ----------------

function loadMinutesHelpers({ messages = [] } = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const turnsStart = src.indexOf('  // Agents in `agents` that don');
  const turnsEnd = src.indexOf('  // Round 1 specifically');
  const minutesStart = src.indexOf('  // Minutes for a standard meeting once every agent');
  const qStart = src.indexOf('  // ---------------- agent questions ----------------');
  assert.ok(turnsStart >= 0 && turnsEnd > turnsStart, 'markers not found in web/app.js — did turnsForRound move?');
  assert.ok(minutesStart >= 0 && qStart > minutesStart, 'markers not found in web/app.js — did writeMinutesIfComplete move?');

  const calls = { generateMeetingMinutes: [], checkAnsweredQuestions: [] };
  const ctx = {
    ALL, GRID_MODES, Set,
    state: { session: { messages: messages.slice(), meeting_minutes: [] } },
    generateMeetingMinutes: (mode) => calls.generateMeetingMinutes.push(mode),
    checkAnsweredQuestions: (opts) => calls.checkAnsweredQuestions.push(opts),
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(turnsStart, turnsEnd)}\n${src.slice(minutesStart, qStart)}\nthis.writeMinutesIfComplete = writeMinutesIfComplete;`, ctx);
  ctx.calls = calls;
  return ctx;
}

let seq = 0;
const row = (speaker, mode) => ({ id: ++seq, seq, role: 'agent', speaker, mode, text: 'answer', error: null });
// Objects built inside the vm context are a different realm's Object, so
// deepEqual's reference check on the prototype fails even when the shape
// matches — round-trip through JSON to compare plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

describe('web/app.js writeMinutesIfComplete — checks for answered questions only once the meeting is complete', () => {
  it('checks for answered questions, quietly, once every agent has answered the round', () => {
    const ctx = loadMinutesHelpers({ messages: ALL.map((a) => row(a, 'round2')) });

    ctx.writeMinutesIfComplete('round2', true);

    assert.deepEqual(plain(ctx.calls.checkAnsweredQuestions), [{ quiet: true }]);
  });

  it('does not check for answered questions while an agent still hasn\'t answered', () => {
    const ctx = loadMinutesHelpers({ messages: [row('regulatory', 'round2')] }); // Luca, Charlie still pending

    ctx.writeMinutesIfComplete('round2', true);

    assert.deepEqual(ctx.calls.checkAnsweredQuestions, []);
  });

  it('does not check for answered questions for a non-grid mode', () => {
    const ctx = loadMinutesHelpers({ messages: [] });

    ctx.writeMinutesIfComplete('custom', true);

    assert.deepEqual(ctx.calls.checkAnsweredQuestions, []);
  });
});
