'use strict';
// POST /api/sessions/:id/turn moves a session still on a retired model
// (config.RETIRED_MODELS) to config.MODEL before running the turn, via
// db.switchModel, and adds session_model to the 'done' SSE event so the
// client updates its picker. Real app.js + auth, in-memory fake db, stubbed
// src/agents.runTurn (never touches OpenRouter).
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
const RETIRED = 'mistralai/mistral-nemo';

let session, messages, nextMsgId, switchModelCalls, beginTurnCalls, runTurnCalls, runTurnImpl;

function addMsg(fields) {
  const m = { id: String(++nextMsgId), seq: messages.length + 1, created_at: new Date().toISOString(), cost_usd: 0, error: null, content_json: null, ...fields };
  messages.push(m);
  return m;
}

describe('POST /api/sessions/:id/turn — retired-model switch', () => {
  let server, baseUrl, cookie, config;

  before(async () => {
    stubModule('agents', { runTurn: async (args) => { runTurnCalls.push(args); return runTurnImpl(args); } });
    const harness = await startApp({
      countUsers: async () => 1,
      getUserById: async (id) => (Number(id) === USER_ID ? { id: USER_ID, email: 'admin@example.com', is_admin: true } : null),
      fullSession: async (id) => (id === SESSION_ID
        ? { ...session, inputs: { product: 'Anatop', country: 'Argentina' }, messages: messages.slice(), sources: [], disagreements: [], autopilot_runs: [], reports: [], meeting_minutes: [], questions: [] }
        : null),
      // Mirrors db.switchModel's contract: no-op when already on that model,
      // otherwise sets it and inserts the transcript note as a message.
      switchModel: async (id, model, describe) => {
        switchModelCalls.push({ id, model });
        if (id !== SESSION_ID) return null;
        const previous = session.model || harness.config.MODEL;
        if (previous === model) return null;
        session.model = model;
        return addMsg({ role: 'system', speaker: 'model', text: describe(previous, model) });
      },
      beginAgentTurn: async (id, fields) => { beginTurnCalls.push({ id, fields }); return addMsg({ ...fields, text: null }); },
      addMessage: async (id, fields) => addMsg(fields),
      updateMessage: async (id, fields) => { const m = messages.find((x) => String(x.id) === String(id)); if (m) Object.assign(m, fields); return m; },
      touchSession: async () => {},
      listSources: async () => [],
      listDisagreements: async () => [],
      listQuestions: async () => [],
      listMessages: async () => messages.slice(),
    });
    server = harness.server;
    baseUrl = harness.baseUrl;
    config = harness.config;
    cookie = `anatop_session=${harness.auth.mintSession({ id: USER_ID })}`;
  });

  after(async () => { await new Promise((resolve) => server.close(resolve)); });

  beforeEach(() => {
    nextMsgId = 100;
    messages = [];
    session = { id: SESSION_ID, title: 'Anatop — Argentina', model: null, owner_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    switchModelCalls = [];
    beginTurnCalls = [];
    runTurnCalls = [];
    runTurnImpl = async () => ({ text: 'A normal answer.', trace: [], usage: { input_tokens: 1, output_tokens: 1, searches: 0 }, model: 'stub', stop_reason: 'stop', cost_usd: 0.01 });
  });

  async function turnSse(body) {
    const res = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, accept: 'text/event-stream' }, body: JSON.stringify(body),
    });
    const raw = await res.text();
    const eventOf = (name) => {
      const m = new RegExp(`event: ${name}\\ndata: (.*)\\n\\n`).exec(raw);
      return m ? JSON.parse(m[1]) : null;
    };
    return { res, raw, eventOf };
  }

  it('a session on a retired model is switched to config.MODEL before the turn runs, and the turn itself runs on the new model', async () => {
    session.model = RETIRED;

    const { eventOf } = await turnSse({ speaker: 'clinical', mode: 'opening' });

    assert.equal(switchModelCalls.length, 1);
    assert.equal(switchModelCalls[0].model, config.MODEL);
    assert.equal(session.model, config.MODEL, 'the fake db really flipped the session\'s model');

    const status = eventOf('status');
    assert.ok(status, 'a status event carrying the switch note was sent ahead of the turn');
    assert.match(status.text, /retired/);

    const done = eventOf('done');
    assert.equal(done.session_model, config.MODEL, '"done" tells the client which model the session is on now');
  });

  it('a session already on the live default model is never switched, and session_model is absent from "done"', async () => {
    session.model = config.MODEL;

    const { eventOf } = await turnSse({ speaker: 'clinical', mode: 'opening' });

    assert.equal(switchModelCalls.length, 0);
    const done = eventOf('done');
    assert.equal('session_model' in done, false);
  });

  it('a session on an unretired non-default model (an explicit pick) is left alone', async () => {
    session.model = 'anthropic/claude-sonnet-5';

    await turnSse({ speaker: 'clinical', mode: 'opening' });

    assert.equal(switchModelCalls.length, 0);
    assert.equal(session.model, 'anthropic/claude-sonnet-5');
  });

  it('the switch note is written to the transcript ahead of the turn\'s own message', async () => {
    session.model = RETIRED;

    await turnSse({ speaker: 'clinical', mode: 'opening' });

    const roles = messages.map((m) => m.role);
    const switchIdx = roles.indexOf('system');
    const turnIdx = messages.findIndex((m) => m.speaker === 'clinical');
    assert.notEqual(switchIdx, -1);
    assert.ok(switchIdx < turnIdx, 'the switch note message comes before the agent turn message');
  });
});
