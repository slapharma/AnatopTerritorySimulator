'use strict';
// src/db.js opens its pg.Pool at module load but never connects until a query
// runs (this worktree ships no .env/DATABASE_URL, so nothing here could reach
// a real database anyway) — so listQuestions/addQuestions are tested by
// monkeypatching the exported `pool.query` directly, the same object `q`/`one`
// close over internally.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

const UNDEFINED_TABLE = Object.assign(new Error('relation "agent_questions" does not exist'), { code: '42P01' });

let originalQuery;
beforeEach(() => { originalQuery = db.pool.query; });
afterEach(() => { db.pool.query = originalQuery; });

describe('db.listQuestions', () => {
  it('queries by session id, ordered by message_id then n, and returns the rows', async () => {
    const calls = [];
    const rows = [{ id: '1', session_id: '39', message_id: '10', n: 1 }];
    db.pool.query = async (text, params) => { calls.push({ text, params }); return { rows }; };

    const out = await db.listQuestions('39');

    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /FROM agent_questions WHERE session_id = \$1 ORDER BY message_id, n/);
    assert.deepEqual(calls[0].params, ['39']);
    assert.deepEqual(out, rows);
  });

  it('returns [] when the table does not exist yet (42P01)', async () => {
    db.pool.query = async () => { throw UNDEFINED_TABLE; };

    const out = await db.listQuestions('39');

    assert.deepEqual(out, []);
  });

  it('rethrows any other database error', async () => {
    const boom = new Error('connection terminated unexpectedly');
    db.pool.query = async () => { throw boom; };

    await assert.rejects(() => db.listQuestions('39'), boom);
  });
});

describe('db.addQuestions', () => {
  const items = [
    { n: 1, addressees: ['clinical'], text: 'Q1' },
    { n: 2, addressees: ['commercial', 'moderator'], text: 'Q2' },
  ];

  it('returns 0 and never queries when there are no items', async () => {
    let called = false;
    db.pool.query = async () => { called = true; return { rows: [] }; };

    const out = await db.addQuestions('39', '100', { asker: 'regulatory', round: 'opening', items: [] });

    assert.equal(out, 0);
    assert.equal(called, false);
  });

  it('inserts each item, joining addressees with a comma, and counts only the rows actually inserted', async () => {
    const calls = [];
    db.pool.query = async (text, params) => {
      calls.push({ text, params });
      // Simulate the first item being new and the second a re-run duplicate
      // (ON CONFLICT (message_id, n) DO NOTHING RETURNING id).
      return { rows: calls.length === 1 ? [{ id: '501' }] : [] };
    };

    const out = await db.addQuestions('39', '100', { asker: 'regulatory', round: 'opening', items });

    assert.equal(out, 1);
    assert.equal(calls.length, 2);
    assert.match(calls[0].text, /INSERT INTO agent_questions/);
    assert.match(calls[0].text, /ON CONFLICT \(message_id, n\) DO NOTHING RETURNING id/);
    assert.deepEqual(calls[0].params, ['39', '100', 1, 'regulatory', 'clinical', 'opening', 'Q1']);
    assert.deepEqual(calls[1].params, ['39', '100', 2, 'regulatory', 'commercial,moderator', 'opening', 'Q2']);
  });

  it('stores round as null when none is given', async () => {
    const calls = [];
    db.pool.query = async (text, params) => { calls.push(params); return { rows: [{ id: '1' }] }; };

    await db.addQuestions('39', '100', { asker: 'regulatory', round: null, items: [items[0]] });

    assert.equal(calls[0][5], null);
  });

  it('returns 0 when the table does not exist yet (42P01)', async () => {
    db.pool.query = async () => { throw UNDEFINED_TABLE; };

    const out = await db.addQuestions('39', '100', { asker: 'regulatory', round: 'opening', items });

    assert.equal(out, 0);
  });

  it('rethrows any other database error', async () => {
    const boom = new Error('deadlock detected');
    db.pool.query = async () => { throw boom; };

    await assert.rejects(() => db.addQuestions('39', '100', { asker: 'regulatory', round: 'opening', items }), boom);
  });
});
