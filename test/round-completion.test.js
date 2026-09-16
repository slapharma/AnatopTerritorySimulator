'use strict';
// A message row with text NULL and error NULL is a turn that never finished:
// either still streaming, or (on Vercel) orphaned when the browser tab that
// drove it navigated away mid-turn. Session 39 was left like that — Luca's
// Challenge row unfinished, Charlie never asked. Such a row is not an answer,
// so it must not satisfy the "previous meeting complete for every agent"
// gate that POST /api/sessions/:id/turn applies before a later meeting.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/start-app');

const USER_ID = 1;
const SESSION_ID = 39;

// Ruth = regulatory, Luca = clinical, Charlie = commercial.
const row = (seq, speaker, mode, extra = {}) => ({
  id: seq, seq, role: 'agent', speaker, mode, text: `${speaker} ${mode} answer`, error: null,
  created_at: new Date().toISOString(), cost_usd: 0, ...extra,
});

describe('POST /api/sessions/:id/turn — round-order gate', () => {
  let server, auth, baseUrl, cookie;
  let messages, beginCalls;

  before(async () => {
    const harness = await startApp({
      countUsers: async () => 1,
      getUserById: async (id) => (id === USER_ID ? { id: USER_ID, email: 'admin@example.com', is_admin: true } : null),
      fullSession: async (id) => (id === SESSION_ID
        ? { id: SESSION_ID, title: 'Anatop · Argentina', model: null, inputs: { product: 'Anatop', country: 'Argentina' },
          messages: [...messages], sources: [], disagreements: [], autopilot_runs: [], reports: [], meeting_minutes: [] }
        : null),
      // Passing the gate reaches beginAgentTurn. Stop there with the app's own
      // 409 so no model call is ever made: 409 = gate passed, 400 = gate held.
      beginAgentTurn: async (id, fields) => {
        beginCalls.push(fields);
        const e = new Error('stopped by test after the round-order gate'); e.code = 'ALREADY_RUNNING'; throw e;
      },
    });
    server = harness.server;
    auth = harness.auth;
    baseUrl = harness.baseUrl;
    cookie = `anatop_session=${auth.mintSession({ id: USER_ID })}`;
  });

  after(async () => { await new Promise((resolve) => server.close(resolve)); });

  beforeEach(() => {
    beginCalls = [];
    messages = [
      row(1, 'regulatory', 'opening'), row(2, 'clinical', 'opening'), row(3, 'commercial', 'opening'),
      row(4, 'regulatory', 'round2'),
    ];
  });

  const turn = (body) => fetch(`${baseUrl}/api/sessions/${SESSION_ID}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie, accept: 'application/json' }, body: JSON.stringify(body),
  });

  it('refuses Converge while one agent\'s Challenge row is unfinished (text NULL, no error)', async () => {
    messages.push(row(5, 'clinical', 'round2', { text: null }), row(6, 'commercial', 'round2'));
    const r = await turn({ speaker: 'regulatory', mode: 'round3' });
    const j = await r.json();
    assert.equal(r.status, 400, `expected the gate to refuse, got ${r.status} ${JSON.stringify(j)}`);
    assert.match(j.error, /Run round2 for all 3 agents/);
    assert.equal(beginCalls.length, 0);
  });

  it('allows Converge once every agent has a finished Challenge answer', async () => {
    messages.push(row(5, 'clinical', 'round2'), row(6, 'commercial', 'round2'));
    const r = await turn({ speaker: 'regulatory', mode: 'round3' });
    assert.equal(r.status, 409, 'gate should pass and reach beginAgentTurn');
    assert.equal(beginCalls.length, 1);
  });

  it('still refuses Converge when a Challenge row failed with an error', async () => {
    messages.push(row(5, 'clinical', 'round2', { text: '', error: 'boom' }), row(6, 'commercial', 'round2'));
    const r = await turn({ speaker: 'regulatory', mode: 'round3' });
    assert.equal(r.status, 400);
  });
});
