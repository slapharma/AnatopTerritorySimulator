'use strict';
// POST /api/sessions/:id/questions/check excludes questions addressed to the
// Moderator from what it asks the model to check: those are the human's own
// to answer, and left in, an unrelated later agent message could get one
// marked answered and drop it off the moderator's Open list before they ever
// saw it. Real app.js + auth, in-memory fake db, stubbed src/agents.runTurn.
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

let questions, updateQuestionCalls, minutesCalls, runTurnCalls, runTurnImpl;

describe('POST /api/sessions/:id/questions/check — moderator questions are excluded', () => {
  let server, baseUrl, cookie;

  before(async () => {
    stubModule('agents', { runTurn: async (args) => { runTurnCalls.push(args); return runTurnImpl(args); } });
    const harness = await startApp({
      countUsers: async () => 1,
      getUserById: async (id) => (Number(id) === USER_ID ? { id: USER_ID, email: 'admin@example.com', is_admin: true } : null),
      fullSession: async (id) => (id === SESSION_ID
        ? {
          id: SESSION_ID, title: 'Anatop · Argentina', model: null, inputs: { product: 'Anatop', country: 'Argentina' },
          messages: [
            { id: '10', seq: 1, role: 'agent', speaker: 'clinical', mode: 'opening', text: 'asked', error: null, content_json: null },
            { id: '11', seq: 2, role: 'agent', speaker: 'commercial', mode: 'round2', text: 'a later message that could look like an answer', error: null, content_json: null },
          ],
          sources: [], disagreements: [], autopilot_runs: [], reports: [], meeting_minutes: [],
          questions: questions.slice(),
        }
        : null),
      listQuestions: async () => questions.slice(),
      updateQuestion: async (id, sid, fields) => {
        updateQuestionCalls.push({ id: String(id), sid, fields });
        const q = questions.find((x) => String(x.id) === String(id));
        if (!q) return null;
        Object.assign(q, { status: fields.status, resolution_note: fields.resolution_note ?? null, answer_message_id: fields.answer_message_id == null ? null : String(fields.answer_message_id) });
        return q;
      },
      listMeetingMinutes: async () => [],
      addMeetingMinutes: async (sid, fields) => { minutesCalls.push({ sid, fields }); return { id: minutesCalls.length, session_id: sid, ...fields }; },
    });
    server = harness.server;
    baseUrl = harness.baseUrl;
    cookie = `anatop_session=${harness.auth.mintSession({ id: USER_ID })}`;
  });

  after(async () => { await new Promise((resolve) => server.close(resolve)); });

  beforeEach(() => {
    questions = [];
    updateQuestionCalls = [];
    minutesCalls = [];
    runTurnCalls = [];
    runTurnImpl = async () => ({ text: '{"answered": []}', trace: [], usage: { input_tokens: 1, output_tokens: 1, searches: 0 }, model: 'stub', stop_reason: 'stop', cost_usd: 0.01 });
  });

  const check = () => fetch(`${baseUrl}/api/sessions/${SESSION_ID}/questions/check`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie, accept: 'application/json' }, body: JSON.stringify({}),
  });

  it('a question addressed only to the moderator is never sent to the model, and the call is skipped entirely when it is the only open one', async () => {
    questions.push({
      id: '1', session_id: SESSION_ID, message_id: '10', n: 1, asker: 'clinical', addressees: 'moderator',
      round: 'opening', text: 'Should we proceed without local bridging data?', status: 'open', resolution_note: null, answer_message_id: null,
    });

    const res = await check();
    const body = await res.json();

    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.updated, 0);
    assert.equal(runTurnCalls.length, 0, 'no open question qualifies, so the model is never called');
  });

  it('a question addressed to an agent AND the moderator ("commercial,moderator") is also excluded', async () => {
    questions.push({
      id: '1', session_id: SESSION_ID, message_id: '10', n: 1, asker: 'clinical', addressees: 'commercial,moderator',
      round: 'opening', text: 'Should we proceed without local bridging data?', status: 'open', resolution_note: null, answer_message_id: null,
    });

    const res = await check();
    const body = await res.json();

    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(runTurnCalls.length, 0);
  });

  it('a question addressed only to an agent IS sent to the model, alongside a moderator one that is excluded', async () => {
    questions.push(
      { id: '1', session_id: SESSION_ID, message_id: '10', n: 1, asker: 'clinical', addressees: 'moderator', round: 'opening', text: 'For the moderator.', status: 'open', resolution_note: null, answer_message_id: null },
      { id: '2', session_id: SESSION_ID, message_id: '10', n: 2, asker: 'clinical', addressees: 'commercial', round: 'opening', text: 'For Charlie.', status: 'open', resolution_note: null, answer_message_id: null },
    );

    const res = await check();
    const body = await res.json();

    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(runTurnCalls.length, 1);
    assert.match(runTurnCalls[0].instruction, /For Charlie\./);
    assert.doesNotMatch(runTurnCalls[0].instruction, /For the moderator\./);
  });
});
