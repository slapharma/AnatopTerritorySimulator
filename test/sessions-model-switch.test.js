'use strict';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/start-app');

const ADMIN_ID = 1;
const USER_ID = 2;
const SESSION_ID = 39;

describe('PATCH /api/sessions/:id — model switch', () => {
  let server, auth, config, baseUrl;
  let session, messages, setModelCalls;
  let adminCookie, userCookie;

  before(async () => {
    const harness = await startApp({
      countUsers: async () => 1,
      getUserById: async (id) => {
        if (id === ADMIN_ID) return { id: ADMIN_ID, email: 'admin@example.com', is_admin: true };
        if (id === USER_ID) return { id: USER_ID, email: 'user@example.com', is_admin: false };
        return null;
      },
      getSession: async (id) => (id === SESSION_ID ? session : null),
      setModel: async (id, model) => { setModelCalls.push({ id, model }); session.model = model; },
      // Mirrors db.switchModel's contract (one transaction in the real thing):
      // no-op when already on that model, otherwise set it and add the note.
      switchModel: async (id, model, describe) => {
        if (id !== SESSION_ID) return null;
        const previous = session.model || config.MODEL;
        if (previous === model) return null;
        setModelCalls.push({ id, model });
        session.model = model;
        const m = { id: messages.length + 1, seq: messages.length + 1, created_at: new Date().toISOString(), cost_usd: 0, role: 'system', speaker: 'model', text: describe(previous, model) };
        messages.push(m);
        return m;
      },
      addMessage: async (id, fields) => {
        const m = { id: messages.length + 1, seq: messages.length + 1, created_at: new Date().toISOString(), cost_usd: 0, ...fields };
        messages.push(m);
        return m;
      },
      renameSession: async () => {},
      updateInputs: async () => {},
      fullSession: async (id) => (id === SESSION_ID
        ? { ...session, inputs: { product: 'Anatop', country: 'Argentina' }, messages: [...messages], sources: [], disagreements: [], autopilot_runs: [], reports: [], meeting_minutes: [] }
        : null),
    });
    server = harness.server;
    auth = harness.auth;
    config = harness.config;
    baseUrl = harness.baseUrl;
    adminCookie = `anatop_session=${auth.mintSession({ id: ADMIN_ID })}`;
    userCookie = `anatop_session=${auth.mintSession({ id: USER_ID })}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  // Every test starts from a clean session/message/call state so ordering
  // and reruns can't leak between cases.
  beforeEach(() => {
    session = {
      id: SESSION_ID, title: 'Anatop — Argentina', model: null,
      owner_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    messages = [];
    setModelCalls = [];
  });

  function patch(cookie, body) {
    return fetch(`${baseUrl}/api/sessions/${SESSION_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie, accept: 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('switching to a different allowed free model updates it and logs exactly one system message naming both models', async () => {
    const nextModel = 'nvidia/nemotron-3-ultra-550b-a55b:free';
    const r = await patch(userCookie, { model: nextModel });
    assert.equal(r.status, 200);

    assert.deepEqual(setModelCalls, [{ id: SESSION_ID, model: nextModel }]);
    assert.equal(session.model, nextModel);

    assert.equal(messages.length, 1);
    const [msg] = messages;
    assert.equal(msg.role, 'system');
    assert.equal(msg.speaker, 'model');
    assert.match(msg.text, /Mistral Nemo/);
    assert.match(msg.text, /Nemotron 3 Ultra 550B/);
  });

  it('PATCHing the model to what it already is (including null standing in for the config default) adds no message and does not call setModel', async () => {
    // session.model starts null; the route resolves that to config.MODEL, so
    // PATCHing with config.MODEL itself must be a no-op, not a "switch".
    const r = await patch(userCookie, { model: config.MODEL });
    assert.equal(r.status, 200);

    assert.deepEqual(setModelCalls, []);
    assert.equal(messages.length, 0);
    assert.equal(session.model, null);
  });

  it('an unknown model id is rejected with 400 and leaves the session untouched', async () => {
    const r = await patch(userCookie, { model: 'totally/unknown-model' });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error, 'Unknown model totally/unknown-model');

    assert.deepEqual(setModelCalls, []);
    assert.equal(messages.length, 0);
  });

  it('a non-admin switching to a paid model is refused with 403 and setModel is never called', async () => {
    const r = await patch(userCookie, { model: 'anthropic/claude-sonnet-5' });
    assert.equal(r.status, 403);
    const body = await r.json();
    assert.equal(body.error, 'Only an admin can select a paid model');

    assert.deepEqual(setModelCalls, []);
    assert.equal(messages.length, 0);
  });

  it('an admin CAN switch to a paid model (the 403 above is about admin status, not the model itself)', async () => {
    const r = await patch(adminCookie, { model: 'anthropic/claude-sonnet-5' });
    assert.equal(r.status, 200);
    assert.deepEqual(setModelCalls, [{ id: SESSION_ID, model: 'anthropic/claude-sonnet-5' }]);
    assert.equal(messages.length, 1);
  });
});
