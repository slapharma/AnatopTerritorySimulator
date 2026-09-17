'use strict';
// src/app.js: GET /api/sessions/:id/intel/:section/export.:format — one
// Intelligence tab as Word or PDF. Real app.js + auth + src/intel-export.js +
// src/export.js, in-memory fake db (test/helpers/start-app.js), never the
// real database.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { startApp } = require('./helpers/start-app');

const SESSION_ID = 39;
const USER_ID = 1;

async function docxText(buf) {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml').async('string');
  return xml.replace(/<[^>]+>/g, ' ');
}

describe('GET /api/sessions/:id/intel/:section/export.:format', () => {
  let server, baseUrl, cookie, fullSessionCalls;

  before(async () => {
    const session = {
      id: SESSION_ID, title: 'Anatop · Argentina', inputs: { product: 'Anatop', country: 'Argentina' },
      messages: [
        { id: '1', role: 'agent', speaker: 'clinical', mode: 'opening', seq: 1, text: 'Clinical baseline.', error: null },
        { id: '2', role: 'agent', speaker: 'commercial', mode: 'opening', seq: 2, text: 'Commercial baseline.', error: null },
      ],
      sources: [], disagreements: [], autopilot_runs: [], reports: [], meeting_minutes: [], questions: [],
    };
    const harness = await startApp({
      countUsers: async () => 1,
      getUserById: async (id) => (Number(id) === USER_ID ? { id: USER_ID, email: 'admin@example.com', is_admin: true } : null),
      fullSession: async (id) => {
        fullSessionCalls.push(id);
        return Number(id) === SESSION_ID ? session : null;
      },
    });
    server = harness.server;
    baseUrl = harness.baseUrl;
    cookie = `anatop_session=${harness.auth.mintSession({ id: USER_ID })}`;
  });

  after(async () => { await new Promise((resolve) => server.close(resolve)); });

  const get = (urlPath, opts = {}) => fetch(`${baseUrl}${urlPath}`, { headers: { ...(opts.noCookie ? {} : { cookie }) } });

  it('requires sign-in, same as every other /api route', async () => {
    fullSessionCalls = [];
    const res = await get(`/api/sessions/${SESSION_ID}/intel/sources/export.docx`, { noCookie: true });
    assert.equal(res.status, 401);
    assert.equal(fullSessionCalls.length, 0, 'never reaches the database for a signed-out request');
  });

  it('404s "Export not found" for an unknown format, without ever querying the database', async () => {
    fullSessionCalls = [];
    const res = await get(`/api/sessions/${SESSION_ID}/intel/sources/export.txt`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'Export not found');
    assert.equal(fullSessionCalls.length, 0);
  });

  it('404s "Export not found" for a section src/intel-export.js does not know, without querying the database', async () => {
    fullSessionCalls = [];
    const res = await get(`/api/sessions/${SESSION_ID}/intel/bogus/export.docx`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'Export not found');
    assert.equal(fullSessionCalls.length, 0);
  });

  it('404s "Export not found" for a prototype property name masquerading as a section', async () => {
    const res = await get(`/api/sessions/${SESSION_ID}/intel/__proto__/export.docx`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'Export not found');
  });

  it('404s "Session not found" for a session id the database does not have', async () => {
    fullSessionCalls = [];
    const res = await get('/api/sessions/999999/intel/sources/export.docx');
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'Session not found');
    assert.equal(fullSessionCalls.length, 1, 'the database was queried once for the missing session');
  });

  it('serves a docx with the correct Content-Type, a Content-Disposition filename, and real docx (PK) magic bytes', async () => {
    const res = await get(`/api/sessions/${SESSION_ID}/intel/sources/export.docx`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.match(res.headers.get('content-disposition'), /attachment; filename="Anatop_Argentina_sources\.docx"/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.slice(0, 2).toString('latin1'), 'PK');
  });

  it('serves a pdf with the correct Content-Type, a Content-Disposition filename, and real PDF (%PDF) magic bytes', async () => {
    const res = await get(`/api/sessions/${SESSION_ID}/intel/sources/export.pdf`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /attachment; filename="Anatop_Argentina_sources\.pdf"/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-');
  });

  it('defaults ?cut to "agent" for the Agent notes tab — one group per speaker', async () => {
    const res = await get(`/api/sessions/${SESSION_ID}/intel/intelligence/export.docx`);
    assert.equal(res.status, 200);
    const text = await docxText(Buffer.from(await res.arrayBuffer()));
    assert.match(text, /Luca \(Clinical\)/);
    assert.match(text, /Charlie \(Commercial\)/);
  });

  it('honours ?cut=meeting on the Agent notes tab — one group per meeting, not per speaker', async () => {
    const res = await get(`/api/sessions/${SESSION_ID}/intel/intelligence/export.docx?cut=meeting`);
    assert.equal(res.status, 200);
    const text = await docxText(Buffer.from(await res.arrayBuffer()));
    assert.match(text, /Baselines/);
    assert.equal(/Luca \(Clinical\)\s*\(\d\)/.test(text), false, 'grouped by meeting, not re-labelled per speaker as a heading');
  });

  // The ?cut whitelist itself (an unrecognised value must be rewritten to
  // "agent", not passed through) is covered precisely, independent of
  // src/intel-export.js's own tolerance for a bad cut, in
  // test/app-intel-export-cut.test.js (a stubbed src/intel-export.js there
  // records exactly what src/app.js hands it).
});
