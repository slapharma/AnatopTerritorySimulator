'use strict';
// The meeting-minutes email links back with ?session=<id> (src/email.js). On
// load, web/app.js opens that session if it is in the user's session list.
// sessions.id is bigserial, which node-pg returns as a string, so the lookup
// must match "39" against the query parameter, not only the number 39 a fake
// db would hand out. Evaluated in a vm like the other web/app.js tests.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

function slice(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  const end = SRC.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `markers not found in web/app.js: ${startMarker}`);
  return SRC.slice(start, end);
}

async function runDeepLink({ search, sessions }) {
  const calls = { opened: [], dashboard: 0, toasts: [] };
  const ctx = {
    URLSearchParams,
    location: { search },
    MODE_LABEL: { opening: 'Baselines' },
    state: { sessions },
    openSession: async (id) => { calls.opened.push(id); },
    showDashboard: () => { calls.dashboard += 1; },
    toast: (t) => calls.toasts.push(t),
  };
  vm.createContext(ctx);
  const block = slice('    const params = new URLSearchParams(location.search);', '    const setSidebarCollapsed');
  await vm.runInContext(`(async () => {\n${block}\n})()`, ctx);
  return calls;
}

describe('web/app.js ?session=<id> deep link', () => {
  for (const [label, id] of [['string id, as node-pg returns bigserial', '39'], ['numeric id', 39]]) {
    it(`opens the linked session for a ${label}`, async () => {
      const calls = await runDeepLink({ search: '?session=39&approved=opening', sessions: [{ id: '12' }, { id }] });
      assert.equal(calls.opened.length, 1, 'deep link fell through to the dashboard');
      assert.equal(String(calls.opened[0]), '39');
      assert.equal(calls.dashboard, 0);
      assert.deepEqual(calls.toasts, ['Meeting approved: Baselines']);
    });
  }

  it('lands on the dashboard when the linked session is not in the list', async () => {
    const calls = await runDeepLink({ search: '?session=40', sessions: [{ id: '39' }] });
    assert.deepEqual(calls.opened, []);
    assert.equal(calls.dashboard, 1);
  });

  it('lands on the dashboard with no ?session', async () => {
    const calls = await runDeepLink({ search: '', sessions: [{ id: '39' }] });
    assert.deepEqual(calls.opened, []);
    assert.equal(calls.dashboard, 1);
  });
});
