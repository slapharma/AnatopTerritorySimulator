'use strict';
// src/db.js's llm_calls ledger (addLlmCall/listLlmCalls). Same technique as
// test/db-questions.test.js: monkeypatch pool.query directly, since src/db.js
// never connects until a query runs and this worktree ships no DATABASE_URL.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

const UNDEFINED_TABLE = Object.assign(new Error('relation "llm_calls" does not exist'), { code: '42P01' });

let originalQuery;
beforeEach(() => { originalQuery = db.pool.query; });
afterEach(() => { db.pool.query = originalQuery; });

describe('db.addLlmCall', () => {
  const fields = {
    category: 'agent_presentation', feature: 'opening', speaker: 'clinical', model: 'google/gemma-4-26b-a4b-it:free',
    message_id: '42', report_id: null, requests: 2, input_tokens: 100, output_tokens: 200, searches: 1,
    cost_usd: 0.015, duration_ms: 4200, error: null, created_by: 'cflack@slapharmagroup.com',
  };

  it('inserts one row with the given fields and returns it', async () => {
    const calls = [];
    const row = { id: '1', session_id: '39', ...fields };
    db.pool.query = async (text, params) => { calls.push({ text, params }); return { rows: [row] }; };

    const out = await db.addLlmCall('39', fields);

    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /INSERT INTO llm_calls/);
    assert.match(calls[0].text, /RETURNING \*/);
    assert.deepEqual(calls[0].params, [
      '39', 'agent_presentation', 'opening', 'clinical', 'google/gemma-4-26b-a4b-it:free', '42', null,
      2, 100, 200, 1, 0.015, 4200, null, 'cflack@slapharmagroup.com',
    ]);
    assert.deepEqual(out, row);
  });

  it('defaults optional numeric fields to 0 and optional ids/strings to null', async () => {
    const calls = [];
    db.pool.query = async (text, params) => { calls.push(params); return { rows: [{}] }; };

    await db.addLlmCall('39', { category: 'other', feature: 'unknown' });

    assert.deepEqual(calls[0], ['39', 'other', 'unknown', null, null, null, null, 0, 0, 0, 0, 0, null, null, null]);
  });

  it('returns null when the llm_calls table does not exist yet (42P01), instead of throwing', async () => {
    db.pool.query = async () => { throw UNDEFINED_TABLE; };

    const out = await db.addLlmCall('39', fields);

    assert.equal(out, null);
  });

  it('returns null, not a 500, when the table exists without app_user grants (42501)', async () => {
    const denied = Object.assign(new Error('permission denied for table llm_calls'), { code: '42501' });
    db.pool.query = async () => { throw denied; };
    const warn = console.warn; console.warn = () => {};
    try {
      assert.equal(await db.addLlmCall('39', fields), null);
      assert.equal(await db.listLlmCalls('39'), null);
    } finally { console.warn = warn; }
  });

  it('rethrows any other database error', async () => {
    const boom = new Error('connection terminated unexpectedly');
    db.pool.query = async () => { throw boom; };

    await assert.rejects(() => db.addLlmCall('39', fields), boom);
  });
});

describe('db.listLlmCalls', () => {
  it('queries by session id, ordered by id, and returns the rows', async () => {
    const calls = [];
    const rows = [{ id: '1', session_id: '39', category: 'other', feature: 'unknown' }];
    db.pool.query = async (text, params) => { calls.push({ text, params }); return { rows }; };

    const out = await db.listLlmCalls('39');

    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /FROM llm_calls WHERE session_id = \$1 ORDER BY id/);
    assert.deepEqual(calls[0].params, ['39']);
    assert.deepEqual(out, rows);
  });

  it('returns null when the llm_calls table does not exist yet (42P01) — summarise() then falls back to messages/reports alone', async () => {
    db.pool.query = async () => { throw UNDEFINED_TABLE; };

    const out = await db.listLlmCalls('39');

    assert.equal(out, null);
  });

  it('rethrows any other database error', async () => {
    const boom = new Error('deadlock detected');
    db.pool.query = async () => { throw boom; };

    await assert.rejects(() => db.listLlmCalls('39'), boom);
  });
});
