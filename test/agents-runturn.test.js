'use strict';
// src/agents.js runTurn against a stubbed global.fetch — no real OpenRouter
// call, no real db (agentKey: 'moderator' skips prompts.js's db.getAgent /
// knowledgeBlock lookups, so no db stubbing is needed here). Confirms the
// normal streaming path, and that a turn which fails mid-loop still attaches
// what it had already spent (err.usage/model/cost_usd) — see the comment
// above runTurn in src/agents.js.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { runTurn } = require('../src/agents');

// One SSE response for streamOnce: each event is a raw OpenRouter chat.completion.chunk.
function sseResponse(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : (sent = true, { done: false, value: bytes })) }) },
    json: async () => ({}),
    text: async () => text,
  };
}

const baseArgs = () => ({
  inputs: { product: 'Anatop', country: 'Argentina' },
  agentKey: 'moderator',
  mode: 'meeting_minutes',
  instruction: 'Summarise the round.',
  messages: [],
  disagreements: [],
  onEvent: () => {},
  model: undefined,
  max_chars: undefined,
});

let originalFetch, originalKey;
beforeEach(() => {
  originalFetch = global.fetch;
  originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key-do-not-use';
});
afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

describe('agents.runTurn', () => {
  it('returns text, usage and cost_usd from a normal single-round reply', async () => {
    global.fetch = async () => sseResponse([
      { model: 'openrouter/model-x', choices: [{ delta: { content: 'Hello ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'world.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0.002 } },
    ]);

    const out = await runTurn(baseArgs());

    assert.equal(out.text, 'Hello world.');
    assert.equal(out.stop_reason, 'stop');
    assert.equal(out.model, 'openrouter/model-x');
    assert.equal(out.cost_usd, 0.002);
    assert.equal(out.usage.input_tokens, 50);
    assert.equal(out.usage.output_tokens, 10);
    assert.equal(out.usage.requests, 1);
  });

  it('attaches the usage, model and cost already spent to the error when a later round fails', async () => {
    let call = 0;
    global.fetch = async () => {
      call++;
      if (call === 1) {
        // Round 0: the model asks to call a tool the app doesn't recognise —
        // runTool handles that locally ("Unknown tool"), with no network call
        // of its own, and the loop goes round again.
        return sseResponse([
          { model: 'openrouter/model-x', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bogus_tool', arguments: '{}' } } ] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.01 } },
        ]);
      }
      // Round 1: the network drops before any more usage is recorded.
      throw new Error('socket hang up');
    };

    await assert.rejects(runTurn(baseArgs()), (err) => {
      assert.match(err.message, /socket hang up/);
      assert.equal(err.model, 'openrouter/model-x');
      assert.equal(err.cost_usd, 0.01, 'cost from round 0, spent before round 1 failed');
      assert.equal(err.usage.requests, 1);
      assert.equal(err.usage.input_tokens, 100);
      assert.equal(err.usage.output_tokens, 20);
      return true;
    });
    assert.equal(call, 2, 'sanity: the second round really was attempted');
  });

  it('a turn that fails before any round completes carries zero usage, not undefined', async () => {
    global.fetch = async () => { throw new Error('DNS lookup failed'); };

    await assert.rejects(runTurn(baseArgs()), (err) => {
      assert.match(err.message, /DNS lookup failed/);
      assert.equal(err.cost_usd, 0);
      assert.equal(err.usage.requests, 0);
      assert.equal(err.usage.input_tokens, 0);
      return true;
    });
  });
});
