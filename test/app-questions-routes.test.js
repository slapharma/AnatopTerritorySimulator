'use strict';
// src/app.js's Agent Questions routes, plus the parts of POST /turn they hook
// into (questions/new_questions on the 'done' SSE event, extraction failure
// not failing the turn, and question-scoped autopilot passing `question` to
// runTurn instead of a stance). Real app.js + auth, in-memory fake db, and a
// stubbed src/agents.runTurn (never touches OpenRouter).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startApp, ROOT } = require('./helpers/start-app');

function stubModule(rel, exports) {
  const p = require.resolve(path.join(ROOT, 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const SESSION_ID = 39;
const USER_ID = 1;

// Mutable per-test state the fake db closes over; reset in beforeEach.
let messages, questions, nextMsgId, nextQId, addQuestionsCalls, updateQuestionCalls, minutesCalls, runTurnCalls, runTurnImpl;

function addMsg(fields) {
  const m = { id: String(++nextMsgId), seq: messages.length + 1, created_at: new Date().toISOString(), cost_usd: 0, error: null, content_json: null, ...fields };
  messages.push(m);
  return m;
}

describe('Agent Questions routes', () => {
  let server, baseUrl, cookie;

  before(async () => {
    // runTurn destructured at app.js load time — indirect through a mutable
    // variable so each test can swap behaviour without reloading the app.
    stubModule('agents', { runTurn: async (args) => { runTurnCalls.push(args); return runTurnImpl(args); } });
    const harness = await startApp({
      countUsers: async () => 1,
      getUserById: async (id) => (Number(id) === USER_ID ? { id: USER_ID, email: 'admin@example.com', is_admin: true } : null),
      fullSession: async (id) => (id === SESSION_ID
        ? {
          id: SESSION_ID, title: 'Anatop · Argentina', model: null, inputs: { product: 'Anatop', country: 'Argentina' },
          messages: messages.slice(), sources: [], disagreements: [], autopilot_runs: [], reports: [], meeting_minutes: [],
          questions: questions.slice(),
        }
        : null),
      getMessage: async (id) => messages.find((m) => String(m.id) === String(id)) || null,
      addMessage: async (id, fields) => addMsg(fields),
      updateMessage: async (id, fields) => { const m = messages.find((x) => String(x.id) === String(id)); if (m) Object.assign(m, fields); return m; },
      beginAgentTurn: async (id, fields) => addMsg({ ...fields, text: null }),
      touchSession: async () => {},
      listSources: async () => [],
      listDisagreements: async () => [],
      listQuestions: async () => questions.slice(),
      addQuestions: async (sid, messageId, payload) => {
        addQuestionsCalls.push({ sid, messageId: String(messageId), payload });
        let added = 0;
        for (const it of payload.items) {
          if (questions.some((q) => q.message_id === String(messageId) && q.n === it.n)) continue;
          questions.push({
            id: String(++nextQId), session_id: SESSION_ID, message_id: String(messageId), n: it.n,
            asker: payload.asker, addressees: it.addressees.join(','), round: payload.round || null,
            text: it.text, status: 'open', resolution_note: null, answer_message_id: null,
          });
          added++;
        }
        return added;
      },
      listMessages: async () => messages.slice(),
      addMeetingMinutes: async (sid, fields) => { minutesCalls.push({ sid, fields }); return { id: minutesCalls.length, session_id: sid, ...fields }; },
      // Returns the stored object itself and updateQuestion below changes it in
      // place, so a route that reads the old status after updating gets the new one.
      getQuestion: async (id, sid) => questions.find((q) => String(q.id) === String(id) && String(q.session_id) === String(sid)) || null,
      updateQuestion: async (id, sid, fields) => {
        updateQuestionCalls.push({ id: String(id), sid, fields });
        const q = questions.find((x) => String(x.id) === String(id));
        if (!q) return null;
        Object.assign(q, {
          status: fields.status, resolution_note: fields.resolution_note ?? null,
          answer_message_id: fields.answer_message_id == null ? null : String(fields.answer_message_id),
        });
        return q;
      },
    });
    server = harness.server;
    baseUrl = harness.baseUrl;
    cookie = `anatop_session=${harness.auth.mintSession({ id: USER_ID })}`;
  });

  after(async () => { await new Promise((resolve) => server.close(resolve)); });

  beforeEach(() => {
    nextMsgId = 100;
    nextQId = 500;
    messages = [];
    questions = [];
    addQuestionsCalls = [];
    updateQuestionCalls = [];
    minutesCalls = [];
    runTurnCalls = [];
    runTurnImpl = async () => ({ text: 'default stub answer', trace: [], usage: { input_tokens: 1, output_tokens: 1, searches: 0 }, model: 'stub', stop_reason: 'stop', cost_usd: 0.01 });
  });

  const api = (method, urlPath, body) => fetch(`${baseUrl}${urlPath}`, {
    method, headers: { 'content-type': 'application/json', cookie, accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // ---------------- PATCH /api/sessions/:id/questions/:qid ----------------

  describe('PATCH /api/sessions/:id/questions/:qid', () => {
    beforeEach(() => {
      questions.push({
        id: '500', session_id: SESSION_ID, message_id: '10', n: 1, asker: 'clinical', addressees: 'commercial',
        round: 'opening', text: 'What is the PAMI timeline?', status: 'answered', resolution_note: 'Answered earlier', answer_message_id: '55',
      });
    });

    it('rejects an unknown status with 400', async () => {
      const res = await api('PATCH', `/api/sessions/${SESSION_ID}/questions/500`, { status: 'bogus' });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /Unknown status bogus/);
    });

    it('404s for a question id that does not exist', async () => {
      const res = await api('PATCH', `/api/sessions/${SESSION_ID}/questions/9999`, { status: 'open' });
      assert.equal(res.status, 404);
    });

    it('404s for a non-numeric question id, without ever querying the database', async () => {
      const res = await api('PATCH', `/api/sessions/${SESSION_ID}/questions/abc`, { status: 'open' });
      assert.equal(res.status, 404);
      assert.equal(updateQuestionCalls.length, 0);
    });

    it('reopening clears the resolution note and the answer message id', async () => {
      const res = await api('PATCH', `/api/sessions/${SESSION_ID}/questions/500`, { status: 'open' });
      assert.equal(res.status, 200, await res.text());
      assert.equal(updateQuestionCalls[0].fields.status, 'open');
      assert.equal(updateQuestionCalls[0].fields.resolution_note, null);
      assert.equal(updateQuestionCalls[0].fields.answer_message_id, null);
    });

    it('keeps the existing note and answer when neither is given for a non-open status change', async () => {
      const res = await api('PATCH', `/api/sessions/${SESSION_ID}/questions/500`, { status: 'escalated' });
      assert.equal(res.status, 200, await res.text());
      assert.equal(updateQuestionCalls[0].fields.resolution_note, 'Answered earlier');
      assert.equal(updateQuestionCalls[0].fields.answer_message_id, '55');
    });

    it('writes a minutes entry for a status change, from the status the question had before the update', async () => {
      const res = await api('PATCH', `/api/sessions/${SESSION_ID}/questions/500`, { status: 'open' });
      assert.equal(res.status, 200, await res.text());
      assert.equal(minutesCalls.length, 1, 'a reopen is an action on the question and gets a minutes entry');
      assert.equal(minutesCalls[0].fields.round, 'question');
      assert.match(minutesCalls[0].fields.text, /\*\*Status:\*\* Answered → Open/);
    });

    it('writes no minutes entry when the status is unchanged and no discussion is closed', async () => {
      const res = await api('PATCH', `/api/sessions/${SESSION_ID}/questions/500`, { status: 'answered' });
      assert.equal(res.status, 200, await res.text());
      assert.equal(minutesCalls.length, 0);
    });

    describe('discussion', () => {
      it('writes a "discussion" minutes entry, even when the status is left unchanged, for a valid run_id', async () => {
        const res = await api('PATCH', `/api/sessions/${SESSION_ID}/questions/500`, {
          status: 'answered', discussion: { run_id: '900', outcome: 'stopped_by_moderator', cycles: 2 },
        });
        assert.equal(res.status, 200, await res.text());
        assert.equal(minutesCalls.length, 1, 'a discussion is an action on the question even when the status did not change');
        assert.match(minutesCalls[0].fields.text, /Discussed to resolution over 2 loops: stopped by the moderator\./);
      });

      it('with no status, leaves the question as the server holds it and writes only the discussion entry', async () => {
        const res = await api('PATCH', `/api/sessions/${SESSION_ID}/questions/500`, {
          discussion: { run_id: '900', outcome: 'failed', cycles: 1 },
        });
        assert.equal(res.status, 200, await res.text());
        assert.equal(updateQuestionCalls.length, 0, 'a run that decided nothing must not rewrite the status');
        assert.equal(questions[0].answer_message_id, '55', 'the existing answer link survives');
        assert.equal(minutesCalls.length, 1);
        assert.match(minutesCalls[0].fields.text, /\*\*Status:\*\* Answered \(unchanged\)/);
        assert.doesNotMatch(minutesCalls[0].fields.text, /\*\*Note:\*\*/);
      });

      it('rejects a PATCH with neither a status nor a valid discussion', async () => {
        const res = await api('PATCH', `/api/sessions/${SESSION_ID}/questions/500`, { discussion: { run_id: 'x' } });
        assert.equal(res.status, 400);
        assert.equal(minutesCalls.length, 0);
      });

      it('ignores a discussion whose run_id is not purely digits, writing no entry when the status is also unchanged', async () => {
        const res = await api('PATCH', `/api/sessions/${SESSION_ID}/questions/500`, {
          status: 'answered', discussion: { run_id: 'not-numeric', outcome: 'resolved', cycles: 2 },
        });
        assert.equal(res.status, 200, await res.text());
        assert.equal(minutesCalls.length, 0, 'the malformed run_id makes discussion null, and the status did not change either');
      });

      it('clamps cycles above 100 down to 100', async () => {
        const res = await api('PATCH', `/api/sessions/${SESSION_ID}/questions/500`, {
          status: 'answered', discussion: { run_id: '900', outcome: 'resolved', cycles: 500 },
        });
        assert.equal(res.status, 200, await res.text());
        assert.match(minutesCalls[0].fields.text, /Discussed to resolution over 100 loops:/);
      });

      it('clamps a negative cycles count up to 0', async () => {
        const res = await api('PATCH', `/api/sessions/${SESSION_ID}/questions/500`, {
          status: 'answered', discussion: { run_id: '900', outcome: 'resolved', cycles: -5 },
        });
        assert.equal(res.status, 200, await res.text());
        assert.match(minutesCalls[0].fields.text, /Discussed to resolution over 0 loops:/);
      });
    });
  });

  // ---------------- POST /api/sessions/:id/questions/:qid/answer ----------------

  describe('POST /api/sessions/:id/questions/:qid/answer', () => {
    beforeEach(() => {
      questions.push({
        id: '500', session_id: SESSION_ID, message_id: '10', n: 1, asker: 'clinical', addressees: 'commercial',
        round: 'opening', text: 'What is the PAMI timeline?', status: 'open', resolution_note: null, answer_message_id: null,
      });
    });

    it('404s for an unknown question id', async () => {
      const res = await api('POST', `/api/sessions/${SESSION_ID}/questions/9999/answer`, { text: 'An answer.' });
      assert.equal(res.status, 404);
    });

    it('rejects an empty (or whitespace-only) answer with 400', async () => {
      const empty = await api('POST', `/api/sessions/${SESSION_ID}/questions/500/answer`, { text: '' });
      assert.equal(empty.status, 400);
      const blank = await api('POST', `/api/sessions/${SESSION_ID}/questions/500/answer`, { text: '   ' });
      assert.equal(blank.status, 400);
    });

    it('adds a user reply addressed to the asker, quoting the question, and marks the question answered', async () => {
      const res = await api('POST', `/api/sessions/${SESSION_ID}/questions/500/answer`, { text: 'PAMI listing takes 12-18 months.' });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));

      assert.equal(body.message.role, 'user');
      assert.equal(body.message.addressed_to, 'clinical');
      assert.match(body.message.text, /What is the PAMI timeline\?/);
      assert.match(body.message.text, /PAMI listing takes 12-18 months\./);

      assert.equal(updateQuestionCalls.length, 1);
      assert.equal(updateQuestionCalls[0].fields.status, 'answered');
      assert.equal(updateQuestionCalls[0].fields.answer_message_id, body.message.id);

      assert.deepEqual(body.respondents, ['clinical']);
    });

    it('writes a minutes entry from the status the question had before it was answered', async () => {
      questions[0].status = 'escalated';
      const res = await api('POST', `/api/sessions/${SESSION_ID}/questions/500/answer`, { text: 'An answer.' });
      assert.equal(res.status, 200, await res.text());
      assert.equal(minutesCalls.length, 1);
      assert.match(minutesCalls[0].fields.text, /\*\*Status:\*\* Escalated to moderator → Answered/);
    });

    it('addresses the reply to "all" and returns no respondents when the asker is not a panel agent', async () => {
      questions[0].asker = 'someone-unrecognised';
      const res = await api('POST', `/api/sessions/${SESSION_ID}/questions/500/answer`, { text: 'An answer.' });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.message.addressed_to, 'all');
      assert.deepEqual(body.respondents, []);
    });
  });

  // ---------------- POST /api/sessions/:id/questions/scan ----------------

  describe('POST /api/sessions/:id/questions/scan', () => {
    it('scans only finished, non-error agent messages with text', async () => {
      addMsg({ role: 'agent', speaker: 'clinical', mode: 'opening', text: 'Luca baseline.\n\nQuestions for Charlie:\n1. What is the PAMI timeline?' });
      addMsg({ role: 'agent', speaker: 'commercial', mode: 'opening', text: null }); // still in flight — skipped
      addMsg({ role: 'agent', speaker: 'commercial', mode: 'opening', text: 'errored', error: 'boom' }); // errored — skipped
      addMsg({ role: 'user', speaker: 'user', mode: 'reply', text: 'Questions for Charlie:\n1. A human wrote this, not an agent.' }); // not an agent — skipped
      addMsg({ role: 'moderator', speaker: 'moderator', mode: 'decision', text: 'Questions for Charlie:\n1. The moderator assistant does not get scanned.' }); // not an agent — skipped

      const res = await api('POST', `/api/sessions/${SESSION_ID}/questions/scan`, {});
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));

      assert.equal(body.added, 1);
      assert.equal(addQuestionsCalls.length, 1, 'addQuestions was attempted for exactly the one qualifying message');
      assert.equal(questions.length, 1);
      assert.equal(questions[0].asker, 'clinical');
    });

    it('does not dedupe itself — it re-attempts every qualifying message every time; the database is what makes a repeat scan a no-op', async () => {
      addMsg({ role: 'agent', speaker: 'clinical', mode: 'opening', text: 'Luca baseline.\n\nQuestions for Charlie:\n1. What is the PAMI timeline?' });

      const first = await (await api('POST', `/api/sessions/${SESSION_ID}/questions/scan`, {})).json();
      const second = await (await api('POST', `/api/sessions/${SESSION_ID}/questions/scan`, {})).json();

      assert.equal(first.added, 1);
      assert.equal(second.added, 0, 'the fake db dedupes by (message_id, n), same as the real ON CONFLICT');
      // The route itself still called addQuestions both times — it did not
      // remember it had already scanned this message.
      assert.equal(addQuestionsCalls.length, 2);
    });
  });

  // ---------------- POST /api/sessions/:id/questions/check ----------------

  describe('POST /api/sessions/:id/questions/check', () => {
    it('never calls the model when there are no open questions', async () => {
      questions.push({
        id: '500', session_id: SESSION_ID, message_id: '10', n: 1, asker: 'clinical', addressees: 'commercial',
        round: 'opening', text: 'Q?', status: 'answered', resolution_note: 'done', answer_message_id: '11',
      });

      const res = await api('POST', `/api/sessions/${SESSION_ID}/questions/check`, {});
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.updated, 0);
      assert.equal(runTurnCalls.length, 0);
    });

    it('updates only the question id the model names, ignoring an id that is not open', async () => {
      addMsg({ role: 'agent', speaker: 'clinical', mode: 'opening', text: 'asked' }); // seq 1
      addMsg({ role: 'agent', speaker: 'commercial', mode: 'round2', text: 'PAMI listing takes 12-18 months.' }); // seq 2
      questions.push(
        { id: '1', session_id: SESSION_ID, message_id: '101', n: 1, asker: 'clinical', addressees: 'commercial', round: 'opening', text: 'What is the PAMI timeline?', status: 'open', resolution_note: null, answer_message_id: null },
        { id: '2', session_id: SESSION_ID, message_id: '101', n: 2, asker: 'clinical', addressees: 'commercial', round: 'opening', text: 'Already answered elsewhere', status: 'answered', resolution_note: 'x', answer_message_id: '1' },
      );
      runTurnImpl = async () => ({
        text: JSON.stringify({ answered: [{ id: '1', seq: 2, note: 'Charlie gave 12-18 months' }, { id: '2', seq: 2, note: 'not open, must be ignored' }] }),
        trace: [], usage: { input_tokens: 1, output_tokens: 1, searches: 0 }, model: 'stub', stop_reason: 'stop', cost_usd: 0.01,
      });

      const res = await api('POST', `/api/sessions/${SESSION_ID}/questions/check`, {});
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));

      assert.equal(body.updated, 1);
      assert.equal(updateQuestionCalls.length, 1);
      assert.equal(updateQuestionCalls[0].id, '1');
      assert.equal(updateQuestionCalls[0].fields.status, 'answered');
      assert.equal(questions[1].status, 'answered', 'id 2 was not open — untouched, even though the model named it too');
      assert.equal(runTurnCalls[0].mode, 'questions_check');
      assert.match(runTurnCalls[0].instruction, /What is the PAMI timeline\?/);
    });

    it('ignores an answer whose seq is not after the question\'s own seq', async () => {
      addMsg({ role: 'agent', speaker: 'clinical', mode: 'opening', text: 'asked' }); // seq 1
      addMsg({ role: 'agent', speaker: 'commercial', mode: 'opening', text: 'answered before the question, impossible in a real transcript but must still be rejected' }); // seq 2
      questions.push({ id: '1', session_id: SESSION_ID, message_id: '101', n: 1, asker: 'clinical', addressees: 'commercial', round: 'opening', text: 'Q?', status: 'open', resolution_note: null, answer_message_id: null });

      // Claims the question's own message (seq 1) answered it — not after.
      runTurnImpl = async () => ({
        text: JSON.stringify({ answered: [{ id: '1', seq: 1, note: 'same message as the question' }] }),
        trace: [], usage: { input_tokens: 1, output_tokens: 1, searches: 0 }, model: 'stub', stop_reason: 'stop', cost_usd: 0.01,
      });

      const res = await api('POST', `/api/sessions/${SESSION_ID}/questions/check`, {});
      const body = await res.json();

      assert.equal(body.updated, 0);
      assert.equal(updateQuestionCalls.length, 0);
      assert.equal(questions[0].status, 'open');
    });

    it('ignores a seq the transcript has no message for', async () => {
      addMsg({ role: 'agent', speaker: 'clinical', mode: 'opening', text: 'asked' }); // seq 1
      questions.push({ id: '1', session_id: SESSION_ID, message_id: '101', n: 1, asker: 'clinical', addressees: 'commercial', round: 'opening', text: 'Q?', status: 'open', resolution_note: null, answer_message_id: null });

      runTurnImpl = async () => ({
        text: JSON.stringify({ answered: [{ id: '1', seq: 999, note: 'no such message' }] }),
        trace: [], usage: { input_tokens: 1, output_tokens: 1, searches: 0 }, model: 'stub', stop_reason: 'stop', cost_usd: 0.01,
      });

      const res = await api('POST', `/api/sessions/${SESSION_ID}/questions/check`, {});
      const body = await res.json();

      assert.equal(body.updated, 0);
      assert.equal(questions[0].status, 'open');
    });

    it('writes one minutes entry per question it marks answered, and none for a claim it skips', async () => {
      addMsg({ role: 'agent', speaker: 'clinical', mode: 'opening', text: 'asked 1' }); // seq 1
      addMsg({ role: 'agent', speaker: 'clinical', mode: 'opening', text: 'asked 2' }); // seq 2
      addMsg({ role: 'agent', speaker: 'commercial', mode: 'round2', text: 'answers both' }); // seq 3
      questions.push(
        { id: '1', session_id: SESSION_ID, message_id: '101', n: 1, asker: 'clinical', addressees: 'commercial', round: 'opening', text: 'Q1?', status: 'open', resolution_note: null, answer_message_id: null },
        { id: '2', session_id: SESSION_ID, message_id: '102', n: 1, asker: 'clinical', addressees: 'commercial', round: 'opening', text: 'Q2?', status: 'open', resolution_note: null, answer_message_id: null },
      );
      runTurnImpl = async () => ({
        text: JSON.stringify({
          answered: [
            { id: '1', seq: 3, note: 'answered in #3' }, // valid: seq 3 is after both questions
            { id: '2', seq: 2, note: 'points at its own question message, not an answer' }, // invalid: seq not after id 2's own seq(2)
          ],
        }),
        trace: [], usage: { input_tokens: 1, output_tokens: 1, searches: 0 }, model: 'stub', stop_reason: 'stop', cost_usd: 0.01,
      });

      const res = await api('POST', `/api/sessions/${SESSION_ID}/questions/check`, {});
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));

      assert.equal(body.updated, 1);
      assert.equal(questions[1].status, 'open', 'the skipped claim (id 2) left untouched');
      assert.equal(minutesCalls.length, 1, 'one entry for the question actually marked answered, none for the skipped claim');
      assert.equal(minutesCalls[0].fields.round, 'question');
      assert.match(minutesCalls[0].fields.text, /The Moderator Assistant found it answered in message #3\./);
    });
  });

  // ---------------- POST /api/sessions/:id/turn ----------------

  describe('POST /api/sessions/:id/turn — questions on the done event', () => {
    const turn = (body) => fetch(`${baseUrl}/api/sessions/${SESSION_ID}/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, accept: 'text/event-stream' }, body: JSON.stringify(body),
    });

    // The route streams Server-Sent Events; grab the payload of the named one.
    async function sseEvent(res, name) {
      const raw = await res.text();
      const re = new RegExp(`event: ${name}\\ndata: (.*)\\n\\n`);
      const m = re.exec(raw);
      assert.ok(m, `no "${name}" event in the SSE stream:\n${raw}`);
      return JSON.parse(m[1]);
    }

    it('includes questions and new_questions, extracted from the agent\'s own reply', async () => {
      runTurnImpl = async () => ({
        text: 'Luca opening.\n\nQuestions for Charlie:\n1. What is the PAMI reimbursement timeline?',
        trace: [], usage: { input_tokens: 1, output_tokens: 1, searches: 0 }, model: 'stub', stop_reason: 'stop', cost_usd: 0.01,
      });

      const res = await turn({ speaker: 'clinical', mode: 'opening' });
      const done = await sseEvent(res, 'done');

      assert.equal(done.new_questions, 1);
      assert.equal(done.questions.length, 1);
      assert.equal(done.questions[0].asker, 'clinical');
      assert.equal(done.questions[0].addressees, 'commercial');
    });

    it('does not fail the turn when question extraction throws — the answer is still saved and sent', async () => {
      runTurnImpl = async () => ({
        text: 'Luca opening.\n\nQuestions for Charlie:\n1. What is the PAMI reimbursement timeline?',
        trace: [], usage: { input_tokens: 1, output_tokens: 1, searches: 0 }, model: 'stub', stop_reason: 'stop', cost_usd: 0.01,
      });
      const realAddQuestions = require(path.join(ROOT, 'src', 'db')).addQuestions;
      require(path.join(ROOT, 'src', 'db')).addQuestions = async () => { throw new Error('storage boom'); };
      try {
        const res = await turn({ speaker: 'clinical', mode: 'opening' });
        const done = await sseEvent(res, 'done');

        assert.equal(done.new_questions, 0, 'extraction failure is swallowed, not surfaced as a count');
        assert.ok(done.message, 'the turn\'s own answer was still saved and sent');
        assert.match(done.message.text, /Luca opening/);
      } finally {
        require(path.join(ROOT, 'src', 'db')).addQuestions = realAddQuestions;
      }
    });

    it('a question-scoped autopilot turn passes `question` (role, labels) to runTurn and no stance, even if one was requested', async () => {
      questions.push({
        id: '7', session_id: SESSION_ID, message_id: '10', n: 1, asker: 'clinical', addressees: 'commercial',
        round: 'opening', text: 'What is the PAMI reimbursement timeline?', status: 'open', resolution_note: null, answer_message_id: null,
      });

      const res = await turn({ speaker: 'commercial', mode: 'autopilot', question_id: '7', stance_index: '3', max_chars: 600 });
      await sseEvent(res, 'done');

      assert.equal(runTurnCalls.length, 1);
      assert.equal(runTurnCalls[0].stance, null);
      assert.deepEqual(runTurnCalls[0].question, {
        text: 'What is the PAMI reimbursement timeline?',
        askerLabel: 'Luca (Clinical)',
        addresseesLabel: 'Charlie (Commercial)',
        role: 'addressee',
      });
    });

    it('the asker\'s own turn on that question is passed role: "asker"', async () => {
      questions.push({
        id: '7', session_id: SESSION_ID, message_id: '10', n: 1, asker: 'clinical', addressees: 'commercial',
        round: 'opening', text: 'What is the PAMI reimbursement timeline?', status: 'open', resolution_note: null, answer_message_id: null,
      });

      const res = await turn({ speaker: 'clinical', mode: 'autopilot', question_id: '7', max_chars: 600 });
      await sseEvent(res, 'done');

      assert.equal(runTurnCalls[0].question.role, 'asker');
    });

    it('enforceCharLimit keeps the trailing QUESTION STATUS line intact through truncation', async () => {
      const verdict = 'QUESTION STATUS: OPEN — still missing the specific ANMAT disposición number.';
      const longBody = 'This is the body of a long answer. '.repeat(40);
      runTurnImpl = async () => ({
        text: `${longBody}\n\n${verdict}`,
        trace: [], usage: { input_tokens: 1, output_tokens: 1, searches: 0 }, model: 'stub', stop_reason: 'stop', cost_usd: 0.01,
      });
      questions.push({
        id: '7', session_id: SESSION_ID, message_id: '10', n: 1, asker: 'clinical', addressees: 'commercial',
        round: 'opening', text: 'Q?', status: 'open', resolution_note: null, answer_message_id: null,
      });

      const res = await turn({ speaker: 'clinical', mode: 'autopilot', question_id: '7', max_chars: 300 });
      const done = await sseEvent(res, 'done');

      assert.ok(done.message.text.length < longBody.length, 'the body was actually truncated');
      assert.ok(done.message.text.trim().endsWith(verdict), `verdict line survived truncation, got:\n${done.message.text}`);
    });
  });
});
