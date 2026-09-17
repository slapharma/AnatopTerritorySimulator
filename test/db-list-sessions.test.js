'use strict';
// src/db.js's listSessions() gained report_count, open_disagreements,
// escalated_questions and meetings_run columns. Same monkeypatch-pool.query
// approach as test/db-questions.test.js: db.js opens its pg.Pool at module
// load but never connects until a query runs (no .env/DATABASE_URL in this
// worktree), so this never touches a real database.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

let originalQuery;
beforeEach(() => { originalQuery = db.pool.query; });
afterEach(() => { db.pool.query = originalQuery; });

describe('db.listSessions', () => {
  it('selects the new aggregate columns exactly once, with no parameters, and returns the rows as-is', async () => {
    const calls = [];
    const rows = [{ id: 1, report_count: '2', open_disagreements: '1', escalated_questions: '0', meetings_run: ['opening', 'round2'] }];
    db.pool.query = async (text, params) => { calls.push({ text, params }); return { rows }; };

    const out = await db.listSessions();

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, undefined);
    assert.match(calls[0].text, /AS report_count/);
    assert.match(calls[0].text, /AS open_disagreements/);
    assert.match(calls[0].text, /AS escalated_questions/);
    assert.match(calls[0].text, /AS meetings_run/);
    assert.deepEqual(out, rows);
  });

  it('counts disagreements whose status is not resolved as open, and questions whose status is escalated', async () => {
    let text = null;
    db.pool.query = async (t) => { text = t; return { rows: [] }; };

    await db.listSessions();

    assert.match(text, /d\.status <> 'resolved'/);
    assert.match(text, /aq\.status = 'escalated'/);
  });

  it('restricts meetings_run to the four standard meeting modes, agent role, and no error', async () => {
    let text = null;
    db.pool.query = async (t) => { text = t; return { rows: [] }; };

    await db.listSessions();

    assert.match(text, /m\.role = 'agent' AND m\.error IS NULL/);
    assert.match(text, /m\.mode IN \('opening', 'round2', 'round3', 'crosstalk'\)/);
  });

  it('rethrows a database error rather than swallowing it', async () => {
    const boom = new Error('connection terminated unexpectedly');
    db.pool.query = async () => { throw boom; };

    await assert.rejects(() => db.listSessions(), boom);
  });
  it('reports 0 escalated questions instead of failing when agent_questions is missing or not granted', async () => {
    for (const code of ['42P01', '42501']) {
      const texts = [];
      db.pool.query = async (text) => {
        texts.push(text);
        if (/agent_questions/.test(text)) { const e = new Error('no table'); e.code = code; throw e; }
        return { rows: [{ id: 1, escalated_questions: 0 }] };
      };
      const warn = console.warn; console.warn = () => {};
      try {
        const out = await db.listSessions();
        assert.deepEqual(out, [{ id: 1, escalated_questions: 0 }]);
      } finally { console.warn = warn; }
      assert.equal(texts.length, 2, code);
      assert.match(texts[1], /0 AS escalated_questions/);
    }
  });
});
