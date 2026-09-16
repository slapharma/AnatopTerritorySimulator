'use strict';
// The browser posts anchor_message_id straight from state.session.messages,
// where messages.id is bigserial and so arrives as a string from node-pg
// ("4821"). The route must store it, not silently drop it to null, or the
// minutes lose their "view meeting" link and the email its transcript anchor.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startApp, ROOT } = require('./helpers/start-app');

// runTurn and the email are destructured when src/app.js loads, so stub the
// modules in the require cache first: no model call, no outbound email.
function stubModule(rel, exports) {
  const p = require.resolve(path.join(ROOT, 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const SESSION_ID = 39;

describe('POST /api/sessions/:id/meeting-minutes — anchor_message_id', () => {
  let server, baseUrl, cookie, added;

  before(async () => {
    stubModule('agents', { runTurn: async () => ({ text: 'Minutes.' }) });
    const realEmail = require(path.join(ROOT, 'src', 'email'));
    stubModule('email', { ...realEmail, sendMeetingMinutesEmail: async () => {} });
    const harness = await startApp({
      countUsers: async () => 1,
      getUserById: async (id) => (Number(id) === 1 ? { id: '1', email: 'admin@example.com', is_admin: true } : null),
      fullSession: async (id) => (id === SESSION_ID
        ? { id: String(SESSION_ID), inputs: {}, messages: [], sources: [], disagreements: [], autopilot_runs: [], reports: [], meeting_minutes: [] }
        : null),
      addMeetingMinutes: async (sessionId, fields) => { added.push(fields); return { id: 7, session_id: sessionId, ...fields }; },
    });
    server = harness.server;
    baseUrl = harness.baseUrl;
    cookie = `anatop_session=${harness.auth.mintSession({ id: 1 })}`;
  });

  after(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => { added = []; });

  const post = (anchor) => fetch(`${baseUrl}/api/sessions/${SESSION_ID}/meeting-minutes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ round: 'opening', label: 'Baselines', anchor_message_id: anchor }),
  });

  for (const [label, anchor, expected] of [
    ['a string id, as node-pg returns bigserial', '4821', 4821],
    ['a numeric id', 4821, 4821],
    ['null', null, null],
    ['a non-numeric string', 'abc', null],
    ['a fractional number', 1.5, null],
  ]) {
    it(`stores ${expected === null ? 'no anchor' : 'the anchor'} for ${label}`, async () => {
      const res = await post(anchor);
      assert.equal(res.status, 200, await res.text());
      assert.equal(added.length, 1);
      assert.equal(added[0].anchor_message_id, expected);
    });
  }
});
