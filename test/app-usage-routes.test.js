'use strict';
// The LLM usage ledger: src/app.js's recordLlmCall at every runTurn call site
// (POST /turn, /questions/check, /meeting-minutes) and GET /api/sessions/:id/usage.
// Real app.js + auth, in-memory fake db, and a stubbed src/agents.runTurn
// (never touches OpenRouter). Same technique as test/app-questions-routes.test.js.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startApp, ROOT } = require('./helpers/start-app');

function stubModule(rel, exports) {
  const p = require.resolve(path.join(ROOT, 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const SESSION_ID = 39;
const ADMIN_ID = 1;
const USER_ID = 2;

// Mutable per-test state the fake db closes over; reset in beforeEach.
let messages, reports, autopilotRuns, nextMsgId, nextReportId, nextCallId, llmCalls, runTurnCalls, runTurnImpl, addLlmCallImpl, ledgerForUsage;

function addMsg(fields) {
  const m = { id: String(++nextMsgId), seq: messages.length + 1, created_at: new Date().toISOString(), cost_usd: 0, error: null, content_json: null, ...fields };
  messages.push(m);
  return m;
}

describe('LLM usage ledger', () => {
  let server, baseUrl, adminCookie, userCookie, config;

  before(async () => {
    // runTurn destructured at app.js load time — indirect through a mutable
    // variable so each test can swap behaviour without reloading the app.
    stubModule('agents', { runTurn: async (args) => { runTurnCalls.push(args); return runTurnImpl(args); } });
    const realEmail = require(path.join(ROOT, 'src', 'email'));
    stubModule('email', { ...realEmail, sendMeetingMinutesEmail: async () => {} });

    const harness = await startApp({
      countUsers: async () => 2,
      getUserById: async (id) => {
        if (Number(id) === ADMIN_ID) return { id: ADMIN_ID, email: 'admin@example.com', is_admin: true };
        if (Number(id) === USER_ID) return { id: USER_ID, email: 'user@example.com', is_admin: false };
        return null;
      },
      fullSession: async (id) => (id === SESSION_ID
        ? {
          id: SESSION_ID, title: 'Anatop · Argentina', model: null, inputs: { product: 'Anatop', country: 'Argentina' },
          messages: messages.slice(), sources: [], disagreements: [], autopilot_runs: autopilotRuns.slice(),
          reports: reports.slice(), meeting_minutes: [], questions: [
            { id: '7', session_id: SESSION_ID, message_id: '10', n: 1, asker: 'clinical', addressees: 'commercial', round: 'opening', text: 'Q?', status: 'open', resolution_note: null, answer_message_id: null },
          ],
        }
        : null),
      getMessage: async (id) => messages.find((m) => String(m.id) === String(id)) || null,
      addMessage: async (id, fields) => addMsg(fields),
      updateMessage: async (id, fields) => { const m = messages.find((x) => String(x.id) === String(id)); if (m) Object.assign(m, fields); return m; },
      beginAgentTurn: async (id, fields) => addMsg({ ...fields, text: null }),
      touchSession: async () => {},
      listSources: async () => [],
      listDisagreements: async () => [],
      listQuestions: async () => [],
      setDecision: async () => {},
      addReport: async (sessionId, fields) => {
        const r = { id: ++nextReportId, session_id: sessionId, created_at: new Date().toISOString(), ...fields };
        reports.push(r);
        return r;
      },
      addMeetingMinutes: async (sessionId, fields) => ({ id: 7, session_id: sessionId, ...fields }),
      addLlmCall: async (sessionId, fields) => addLlmCallImpl(sessionId, fields),
      listLlmCalls: async (id) => (id === SESSION_ID ? ledgerForUsage : null),
    });
    server = harness.server;
    baseUrl = harness.baseUrl;
    config = harness.config;
    adminCookie = `anatop_session=${harness.auth.mintSession({ id: ADMIN_ID })}`;
    userCookie = `anatop_session=${harness.auth.mintSession({ id: USER_ID })}`;
  });

  after(async () => { await new Promise((resolve) => server.close(resolve)); });

  beforeEach(() => {
    nextMsgId = 100;
    nextReportId = 900;
    nextCallId = 5000;
    messages = [];
    reports = [];
    autopilotRuns = [];
    llmCalls = [];
    ledgerForUsage = [];
    runTurnCalls = [];
    runTurnImpl = async () => ({
      text: 'Stub answer.', trace: [], usage: { input_tokens: 10, output_tokens: 20, searches: 0 }, model: 'stub-model', stop_reason: 'stop', cost_usd: 0.02,
    });
    addLlmCallImpl = async (sessionId, fields) => {
      const row = { id: String(++nextCallId), session_id: sessionId, created_at: new Date().toISOString(), ...fields };
      llmCalls.push(row);
      return row;
    };
  });

  const api = (method, urlPath, body, cookie = adminCookie) => fetch(`${baseUrl}${urlPath}`, {
    method, headers: { 'content-type': 'application/json', cookie, accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const turn = (body, cookie = adminCookie) => fetch(`${baseUrl}/api/sessions/${SESSION_ID}/turn`, {
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

  // ---------------- POST /api/sessions/:id/turn ----------------

  describe('POST /api/sessions/:id/turn', () => {
    it('records an agent presentation call against the message it produced', async () => {
      const res = await turn({ speaker: 'clinical', mode: 'opening' });
      const done = await sseEvent(res, 'done');

      assert.equal(llmCalls.length, 1);
      const call = llmCalls[0];
      assert.equal(call.category, 'agent_presentation');
      assert.equal(call.feature, 'opening');
      assert.equal(call.speaker, 'clinical');
      assert.equal(call.message_id, done.message.id);
      assert.equal(call.report_id, null);
      assert.equal(call.model, 'stub-model');
      assert.equal(call.cost_usd, 0.02);
      assert.equal(call.error, null);
      assert.equal(call.created_by, 'admin@example.com');
    });

    it('classifies a question-scoped autopilot turn as question_resolution/question_discussion', async () => {
      const res = await turn({ speaker: 'commercial', mode: 'autopilot', question_id: '7', max_chars: 600 });
      await sseEvent(res, 'done');

      assert.equal(llmCalls.length, 1);
      assert.equal(llmCalls[0].category, 'question_resolution');
      assert.equal(llmCalls[0].feature, 'question_discussion');
    });

    it('classifies a disagreement-scoped custom meeting as disagreement_resolution/disagreement_discussion', async () => {
      const res = await turn({ speaker: 'clinical', mode: 'custom', disagreement_n: '2', instruction: 'Discuss this.' });
      await sseEvent(res, 'done');

      assert.equal(llmCalls.length, 1);
      assert.equal(llmCalls[0].category, 'disagreement_resolution');
      assert.equal(llmCalls[0].feature, 'disagreement_discussion');
    });

    it('records an interim report against the report id, with no message_id', async () => {
      runTurnImpl = async () => ({
        text: 'Interim report text.', trace: [], usage: { input_tokens: 50, output_tokens: 100, searches: 2 }, model: 'stub-model', stop_reason: 'stop', cost_usd: 0.10,
      });
      const res = await turn({ speaker: 'moderator', mode: 'report', kind: 'interim', depth: 'standard' });
      const done = await sseEvent(res, 'done');

      assert.equal(llmCalls.length, 1);
      const call = llmCalls[0];
      assert.equal(call.category, 'reports');
      assert.equal(call.feature, 'report_interim');
      assert.equal(call.report_id, done.report.id);
      assert.equal(call.message_id, null);
      assert.equal(call.cost_usd, 0.10);
    });

    it('records a final report exactly once, against the report id — not a second time for its transcript copy', async () => {
      runTurnImpl = async () => ({
        text: 'Final report text.', trace: [], usage: { input_tokens: 50, output_tokens: 100, searches: 0 }, model: 'stub-model', stop_reason: 'stop', cost_usd: 0.30,
      });
      const res = await turn({ speaker: 'moderator', mode: 'report', kind: 'final', depth: 'standard' });
      const done = await sseEvent(res, 'done');

      assert.ok(done.message, 'Final still leaves a backward-compat transcript message');
      assert.equal(llmCalls.length, 1, 'exactly one ledger row for the whole Final report turn');
      assert.equal(llmCalls[0].category, 'reports');
      assert.equal(llmCalls[0].feature, 'report_final');
      assert.equal(llmCalls[0].report_id, done.report.id);
    });

    it('records the classified error and the partial cost the model call had already spent, on failure', async () => {
      runTurnImpl = async () => {
        const err = new Error('OpenRouter HTTP 500: upstream error');
        err.usage = { input_tokens: 7, output_tokens: 3, searches: 1 };
        err.model = 'stub-model';
        err.cost_usd = 0.004;
        throw err;
      };
      const res = await turn({ speaker: 'clinical', mode: 'opening' });
      const evt = await sseEvent(res, 'error');

      assert.equal(llmCalls.length, 1);
      const call = llmCalls[0];
      assert.equal(call.category, 'agent_presentation');
      assert.equal(call.feature, 'opening');
      assert.match(call.error, /OpenRouter HTTP 500/);
      assert.equal(call.cost_usd, 0.004);
      assert.equal(call.message_id, evt.message_id);
    });

    it('records the turn as cleared, with its own error text, when the message row was cleared mid-run', async () => {
      runTurnImpl = async () => {
        // Simulate Resume clearing a stuck turn while the model call was still
        // in flight: the only row in this test is the one beginAgentTurn made.
        messages.length = 0;
        return { text: 'Too late.', trace: [], usage: { input_tokens: 1, output_tokens: 1, searches: 0 }, model: 'stub-model', stop_reason: 'stop', cost_usd: 0.01 };
      };
      const res = await turn({ speaker: 'clinical', mode: 'opening' });
      const evt = await sseEvent(res, 'error');

      assert.equal(evt.code, 'CLEARED');
      assert.equal(llmCalls.length, 1, 'still recorded, so the spend is not silently lost');
      assert.match(llmCalls[0].error, /cleared before it finished/i);
    });

    it('does not fail the turn when addLlmCall itself throws', async () => {
      addLlmCallImpl = async () => { throw new Error('ledger insert boom'); };
      const res = await turn({ speaker: 'clinical', mode: 'opening' });
      const done = await sseEvent(res, 'done');

      assert.equal(llmCalls.length, 0, 'the row never landed');
      assert.ok(done.message, 'but the turn itself still completed and sent its answer');
      assert.match(done.message.text, /Stub answer/);
    });
  });

  // ---------------- POST /api/sessions/:id/questions/check ----------------

  describe('POST /api/sessions/:id/questions/check', () => {
    it('records the answered-check against the moderator, with no message_id or report_id', async () => {
      runTurnImpl = async () => ({
        text: JSON.stringify({ answered: [] }), trace: [], usage: { input_tokens: 4, output_tokens: 6, searches: 0 }, model: 'stub-model', stop_reason: 'stop', cost_usd: 0.005,
      });
      const res = await api('POST', `/api/sessions/${SESSION_ID}/questions/check`, {});
      assert.equal(res.status, 200, await res.text());

      assert.equal(llmCalls.length, 1);
      assert.equal(llmCalls[0].category, 'question_resolution');
      assert.equal(llmCalls[0].feature, 'questions_check');
      assert.equal(llmCalls[0].speaker, 'moderator');
      assert.equal(llmCalls[0].message_id, null);
      assert.equal(llmCalls[0].report_id, null);
      assert.equal(llmCalls[0].cost_usd, 0.005);
    });

    it('records the failure and still surfaces a server error to the caller', async () => {
      runTurnImpl = async () => { throw new Error('model unavailable'); };
      const res = await api('POST', `/api/sessions/${SESSION_ID}/questions/check`, {});

      assert.equal(res.status, 500);
      assert.equal(llmCalls.length, 1);
      assert.equal(llmCalls[0].category, 'question_resolution');
      assert.match(llmCalls[0].error, /model unavailable/);
    });
  });

  // ---------------- POST /api/sessions/:id/meeting-minutes ----------------

  describe('POST /api/sessions/:id/meeting-minutes', () => {
    it('records the minutes call against the moderator', async () => {
      runTurnImpl = async () => ({
        text: 'Minutes.', trace: [], usage: { input_tokens: 3, output_tokens: 9, searches: 0 }, model: 'stub-model', stop_reason: 'stop', cost_usd: 0.002,
      });
      const res = await api('POST', `/api/sessions/${SESSION_ID}/meeting-minutes`, { round: 'opening', label: 'Baselines' });
      assert.equal(res.status, 200, await res.text());

      assert.equal(llmCalls.length, 1);
      assert.equal(llmCalls[0].category, 'meeting_minutes');
      assert.equal(llmCalls[0].feature, 'meeting_minutes');
      assert.equal(llmCalls[0].cost_usd, 0.002);
    });

    it('records the failure and still surfaces a server error to the caller', async () => {
      runTurnImpl = async () => { throw new Error('model unavailable'); };
      const res = await api('POST', `/api/sessions/${SESSION_ID}/meeting-minutes`, { round: 'opening', label: 'Baselines' });

      assert.equal(res.status, 500);
      assert.equal(llmCalls.length, 1);
      assert.equal(llmCalls[0].category, 'meeting_minutes');
      assert.match(llmCalls[0].error, /model unavailable/);
    });
  });

  // ---------------- GET /api/sessions/:id/usage ----------------

  describe('GET /api/sessions/:id/usage', () => {
    it('403s for a signed-in user who is not an admin', async () => {
      const res = await api('GET', `/api/sessions/${SESSION_ID}/usage`, undefined, userCookie);
      assert.equal(res.status, 403);
    });

    it('404s for a session that does not exist', async () => {
      const res = await api('GET', '/api/sessions/999999/usage');
      assert.equal(res.status, 404);
    });

    it('returns categories and the USD-to-GBP rate alongside the summary, for an admin', async () => {
      ledgerForUsage = [];
      const res = await api('GET', `/api/sessions/${SESSION_ID}/usage`);
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));

      assert.ok(Array.isArray(body.categories) && body.categories.length > 0);
      assert.equal(body.usd_to_gbp, config.USD_TO_GBP);
      assert.equal(body.total.cost_usd, 0);
      assert.equal(body.ledger_available, true);
    });

    it('merges a ledger row with a pre-ledger legacy message into one total, with no double count', async () => {
      ledgerForUsage = [{
        id: '1', session_id: SESSION_ID, category: 'agent_presentation', feature: 'opening', speaker: 'clinical', model: 'm',
        message_id: '10', report_id: null, requests: 1, input_tokens: 10, output_tokens: 20, searches: 0,
        cost_usd: 0.10, duration_ms: 500, error: null, created_at: new Date().toISOString(),
      }];
      messages = [
        // Already in the ledger by message_id — must not be double counted.
        { id: '10', role: 'agent', speaker: 'clinical', mode: 'opening', cost_usd: 0.10, input_tokens: 10, output_tokens: 20, error: null, content_json: null, created_at: new Date().toISOString() },
        // Pre-ledger legacy row with its own cost, no matching ledger entry.
        { id: '11', role: 'agent', speaker: 'commercial', mode: 'round2', cost_usd: 0.05, input_tokens: 5, output_tokens: 5, error: null, content_json: null, created_at: new Date().toISOString() },
      ];

      const res = await api('GET', `/api/sessions/${SESSION_ID}/usage`);
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));

      assert.equal(body.call_count, 2);
      assert.equal(body.legacy_calls, 1);
      assert.ok(Math.abs(body.total.cost_usd - 0.15) < 1e-9);
    });
  });
});
