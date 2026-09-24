'use strict';
// src/agents.js's draftProblem, exercised through runTurn: a panel agent's
// finished draft is checked before the turn is allowed to end, and sent back
// for one rewrite per problem (at most 2 per turn) — src/agents.js's own
// comment above draftProblem. global.fetch is stubbed (no real OpenRouter
// call); src/db and src/search are stubbed in-process so no real Postgres or
// network is touched (db.getAgent -> null gives an agent both abilities by
// default; db.listKnowledgeItems -> [] means no knowledge block).
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function stubModule(rel, exports) {
  const p = require.resolve(path.join(ROOT, 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// TOOLS is only ever read to build the schema sent to the model — runTool's
// own logic switches on call.name, not on this list — so a minimal stand-in
// naming the two tools is enough; no need to pull in the real search.js.
const STUB_TOOLS = [
  { type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: { query: { type: 'string' } } } } },
  { type: 'function', function: { name: 'open_url', parameters: { type: 'object', properties: { url: { type: 'string' } } } } },
];

let searchImpl;
before(() => {
  stubModule('db', { getAgent: async () => null, listKnowledgeItems: async () => [] });
  stubModule('search', {
    webSearch: async (...a) => searchImpl.webSearch(...a),
    openUrl: async (...a) => searchImpl.openUrl(...a),
    TOOLS: STUB_TOOLS,
  });
});

const { runTurn } = require('../src/agents');

function sseResponse(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true, status: 200, headers: { get: () => null },
    body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : (sent = true, { done: false, value: bytes })) }) },
    json: async () => ({}), text: async () => text,
  };
}
function textEvent(content, finish) { return { model: 'stub-model', choices: [{ delta: { content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }; }
function toolCallEvent(name, args) {
  return { model: 'stub-model', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: JSON.stringify(args) } }] } }] };
}
function finishToolCalls() { return { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }; }

const baseArgs = () => ({
  inputs: { product: 'Anatop', country: 'Argentina' },
  agentKey: 'clinical',
  mode: 'opening',
  instruction: 'Give your baseline view.',
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
  searchImpl = {
    webSearch: async () => ({ results: [{ url: 'https://kfda.go.kr/notice', title: 'KFDA notice', snippet: 'snippet' }] }),
    openUrl: async () => ({ url: 'https://kfda.go.kr/notice', title: 'KFDA notice', blocked: false, text: 'The KFDA requires local bridging data for topical GTN products before approval is granted.' }),
  };
});
afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
});

describe('agents.runTurn — draft nudges', () => {
  it('a research-mode draft with zero searches is sent back once ("research"), then accepted', async () => {
    let call = 0;
    global.fetch = async () => {
      call++;
      if (call === 1) return sseResponse([textEvent('Baseline answer with no evidence at all.', 'stop')]);
      return sseResponse([textEvent('Rewritten baseline, still no search run.', 'stop')]);
    };

    const out = await runTurn(baseArgs());

    assert.equal(call, 2, 'exactly one nudge round happened');
    assert.equal(out.text, 'Rewritten baseline, still no search run.');
    assert.deepEqual(out.research.nudges, ['research']);
    assert.equal(out.research.required, true);
  });

  it('a draft that searched but opened nothing is sent back once ("read"), then accepted', async () => {
    let call = 0;
    global.fetch = async () => {
      call++;
      if (call === 1) return sseResponse([toolCallEvent('web_search', { query: 'ANMAT bridging data' }), finishToolCalls()]);
      if (call === 2) return sseResponse([textEvent('Answer built only from the search snippet.', 'stop')]);
      return sseResponse([textEvent('Rewritten, still nothing opened.', 'stop')]);
    };

    const out = await runTurn(baseArgs());

    assert.equal(call, 3);
    assert.equal(out.text, 'Rewritten, still nothing opened.');
    assert.deepEqual(out.research.nudges, ['read']);
    assert.equal(out.research.searches, 1);
    assert.equal(out.research.opens, 0);
  });

  it('a VERIFIED tag whose quote is not on the opened page is sent back once ("tags") with the reason, then accepted once corrected', async () => {
    const badTag = '[VERIFIED — KFDA, https://kfda.go.kr/notice, 2026-01-01, "words that never appear on this page at all for sure"]';
    const goodTag = '[VERIFIED — KFDA, https://kfda.go.kr/notice, 2026-01-01, "requires local bridging data for topical GTN products"]';
    let call = 0;
    global.fetch = async () => {
      call++;
      if (call === 1) return sseResponse([toolCallEvent('web_search', { query: 'ANMAT bridging data' }), finishToolCalls()]);
      if (call === 2) return sseResponse([toolCallEvent('open_url', { url: 'https://kfda.go.kr/notice' }), finishToolCalls()]);
      if (call === 3) return sseResponse([textEvent(`Local data is required. ${badTag}`, 'stop')]);
      return sseResponse([textEvent(`Local data is required. ${goodTag}`, 'stop')]);
    };

    const out = await runTurn(baseArgs());

    assert.equal(call, 4);
    assert.match(out.text, /requires local bridging data for topical GTN products/);
    assert.deepEqual(out.research.nudges, ['tags']);
    assert.equal(out.research.opens, 1);
  });

  it('caps at 2 nudges per turn even when a third problem remains in the second rewrite', async () => {
    let call = 0;
    global.fetch = async () => {
      call++;
      // Round 1: no search at all -> "research" nudge.
      if (call === 1) return sseResponse([textEvent('Baseline with no search and an unverifiable tag: [VERIFIED — X, https://kfda.go.kr/notice, 2026-01-01, "words never opened or checked at all here"]', 'stop')]);
      // Round 2: still no search call made by the (stubbed) model, but now the
      // nudge history already holds "research", so the SAME kind is not sent
      // twice; the draft is unchanged so the "tags" problem would still apply.
      if (call === 2) return sseResponse([toolCallEvent('web_search', { query: 'x' }), finishToolCalls()]);
      // Round 3: after a search with no open -> "read" nudge (2nd nudge, cap reached).
      if (call === 3) return sseResponse([textEvent('Answer from a snippet, still bad tag: [VERIFIED — X, https://kfda.go.kr/notice, 2026-01-01, "words never opened or checked at all here"]', 'stop')]);
      // Round 4: at the cap now — accepted as-is, tag issue included, uncorrected.
      return sseResponse([textEvent('Final answer, still carrying the bad tag: [VERIFIED — X, https://kfda.go.kr/notice, 2026-01-01, "words never opened or checked at all here"]', 'stop')]);
    };

    const out = await runTurn(baseArgs());

    assert.equal(call, 4, 'the loop stopped once 2 nudges had been sent, not continuing for the still-unfixed tag');
    assert.deepEqual(out.research.nudges, ['research', 'read']);
    // agents.js itself never downgrades a tag — that is transcript.js's job —
    // so the still-bad VERIFIED tag survives untouched in the accepted draft.
    assert.match(out.text, /\[VERIFIED — X,/);
  });

  it('the Moderator Assistant\'s draft is never nudged, even with zero searches in a research mode', async () => {
    global.fetch = async () => sseResponse([textEvent('Decision output with no search at all.', 'stop')]);

    const out = await runTurn({ ...baseArgs(), agentKey: 'moderator', mode: 'opening' });

    assert.equal(out.text, 'Decision output with no search at all.');
    assert.deepEqual(out.research.nudges, []);
  });
});
