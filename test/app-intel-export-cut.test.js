'use strict';
// GET /api/sessions/:id/intel/:section/export.:format — the ?cut= whitelist
// specifically. src/intel-export.js is stubbed out so this measures exactly
// what src/app.js passes as `cut`, independent of src/intel-export.js's own
// (separately tested) tolerance for an unrecognised cut — a route-level
// regression here would otherwise be masked by that tolerance.
// Own file/process: src/app.js does `const intelExport = require('./intel-export')`
// at module load, so the stub has to be in place before the one require('../src/app')
// in this process — sharing a process (and so the module cache) with a test
// that loads the real module would make the stub a no-op for this one.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startApp, ROOT } = require('./helpers/start-app');

const SESSION_ID = 39;
const USER_ID = 1;

function stubModule(rel, exports) {
  const p = require.resolve(path.join(ROOT, 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

describe('GET .../intel/:section/export.:format — ?cut whitelist', () => {
  let server, baseUrl, cookie, capturedOpts;

  before(async () => {
    stubModule('intel-export', {
      SECTIONS: { intelligence: { title: 'Agent notes' } },
      sectionDoc: (s, section, opts) => { capturedOpts = opts; return { key: section, title: 'Agent notes', markdown: 'Body.' }; },
    });
    const harness = await startApp({
      countUsers: async () => 1,
      getUserById: async (id) => (Number(id) === USER_ID ? { id: USER_ID, email: 'admin@example.com', is_admin: true } : null),
      fullSession: async (id) => (Number(id) === SESSION_ID
        ? { id: SESSION_ID, title: 'S', inputs: { product: 'P', country: 'C' }, messages: [], sources: [], disagreements: [], autopilot_runs: [], reports: [] }
        : null),
    });
    server = harness.server;
    baseUrl = harness.baseUrl;
    cookie = `anatop_session=${harness.auth.mintSession({ id: USER_ID })}`;
  });

  after(async () => { await new Promise((resolve) => server.close(resolve)); });

  const get = (urlPath) => fetch(`${baseUrl}${urlPath}`, { headers: { cookie } });

  it('passes a whitelisted cut straight through', async () => {
    capturedOpts = null;
    const res = await get(`/api/sessions/${SESSION_ID}/intel/intelligence/export.docx?cut=meeting`);
    assert.equal(res.status, 200);
    assert.deepEqual(capturedOpts, { cut: 'meeting' });
  });

  it('defaults to "agent" with no ?cut given', async () => {
    capturedOpts = null;
    const res = await get(`/api/sessions/${SESSION_ID}/intel/intelligence/export.docx`);
    assert.equal(res.status, 200);
    assert.deepEqual(capturedOpts, { cut: 'agent' });
  });

  it('rewrites an unrecognised ?cut to "agent" rather than passing it through', async () => {
    capturedOpts = null;
    const res = await get(`/api/sessions/${SESSION_ID}/intel/intelligence/export.docx?cut=drop-table`);
    assert.equal(res.status, 200);
    assert.deepEqual(capturedOpts, { cut: 'agent' }, 'an arbitrary query value must never reach the builder unfiltered');
  });
});
