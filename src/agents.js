'use strict';
// Runs one agent turn against OpenRouter (OpenAI-compatible chat completions) with
// streaming and a tool loop for web_search / open_url. Text streams back through onEvent.
const config = require('./config');
const { systemPrompt, turnUserMessage } = require('./prompts');
const search = require('./search');

function apiKey() {
  const k = process.env.OPENROUTER_API_KEY;
  if (!k) {
    const err = new Error('OPENROUTER_API_KEY is not set. Copy .env.example to .env and paste your key.');
    err.code = 'NO_API_KEY';
    throw err;
  }
  return k;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One streamed request. Returns { text, reasoning, toolCalls, finish, usage }.
async function streamOnce({ messages, maxTokens, onEvent }) {
  const body = {
    model: config.MODEL,
    models: [config.MODEL, ...config.FALLBACK_MODELS],
    messages,
    tools: search.TOOLS,
    tool_choice: 'auto',
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
    reasoning: { effort: config.REASONING_EFFORT },
    usage: { include: true },
  };
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${config.OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost',
        'X-Title': 'Launch Working Group',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt < config.RETRY_ON_429) {
      const wait = Math.min(30000, Number(res.headers.get('retry-after') || 0) * 1000 || 5000 * (attempt + 1));
      onEvent('status', { text: `Rate limited by OpenRouter; retrying in ${Math.round(wait / 1000)}s…` });
      await res.text().catch(() => {});
      await sleep(wait);
      continue;
    }
    break;
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j.error && (j.error.message || JSON.stringify(j.error))) || JSON.stringify(j); } catch { detail = await res.text().catch(() => ''); }
    const err = new Error(`OpenRouter HTTP ${res.status}: ${detail}`.slice(0, 500));
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let reasoning = '';
  let finish = null;
  let usage = null;
  let model = null;
  const toolCalls = new Map(); // index -> {id, name, args}
  let announcedThinking = false;

  const handle = (chunk) => {
    if (chunk.error) {
      const err = new Error(`OpenRouter error mid-stream: ${chunk.error.message || JSON.stringify(chunk.error)}`);
      throw err;
    }
    if (chunk.usage) usage = chunk.usage;
    if (chunk.model) model = chunk.model;
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) return;
    const d = choice.delta || {};
    if (d.reasoning && !announcedThinking) { announcedThinking = true; onEvent('status', { text: 'Thinking…' }); }
    if (d.reasoning) reasoning += d.reasoning;
    if (d.content) { text += d.content; onEvent('text', { delta: d.content }); }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCalls.has(idx)) toolCalls.set(idx, { id: tc.id || `call_${idx}`, name: '', args: '' });
        const cur = toolCalls.get(idx);
        if (tc.id) cur.id = tc.id;
        if (tc.function && tc.function.name) cur.name += tc.function.name;
        if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line || line.startsWith(':')) continue; // keep-alive comments
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      handle(chunk);
    }
  }
  return { text, reasoning, toolCalls: [...toolCalls.values()], finish, usage, model };
}

async function runTool(call, counters, onEvent) {
  let args = {};
  try { args = call.args ? JSON.parse(call.args) : {}; } catch { return { ok: false, content: `Could not parse arguments: ${call.args}` }; }
  try {
    if (call.name === 'web_search') {
      if (counters.searches >= config.SEARCH.max_searches_per_turn) return { ok: false, content: 'Search limit for this turn reached. Write your answer with what you have; tag anything unverified as ESTIMATE or UNKNOWN.' };
      counters.searches++;
      const q = String(args.query || '').trim();
      onEvent('search', { query: q });
      const r = await search.webSearch(q);
      return { ok: true, trace: { type: 'search', query: q, results: r.results }, content: JSON.stringify(r.results.length ? r.results : { note: 'No results. Try different wording or the local language.' }) };
    }
    if (call.name === 'open_url') {
      if (counters.opens >= config.SEARCH.max_opens_per_turn) return { ok: false, content: 'Page-open limit for this turn reached. Rely on the snippets you already have.' };
      counters.opens++;
      onEvent('status', { text: `Reading ${String(args.url).slice(0, 80)}…` });
      const p = await search.openUrl(String(args.url || ''));
      return { ok: true, trace: { type: 'open', url: p.url, title: p.title, status: p.status }, content: JSON.stringify({ url: p.url, title: p.title, text: p.text }) };
    }
    return { ok: false, content: `Unknown tool ${call.name}` };
  } catch (e) {
    return { ok: false, content: `Tool error: ${e.message}` };
  }
}

/**
 * Runs one turn. Returns { text, trace, usage, model, stop_reason, cost_usd }.
 * onEvent(name, payload): 'status' {text}, 'text' {delta}, 'search' {query}
 */
async function runTurn({ inputs, agentKey, mode, instruction, messages, onEvent }) {
  apiKey();
  const convo = [
    { role: 'system', content: systemPrompt(agentKey, inputs) },
    { role: 'user', content: turnUserMessage({ agentKey, mode, instruction, messages }) },
  ];
  const maxTokens = mode === 'decision' ? config.MAX_TOKENS_DECISION : config.MAX_TOKENS_AGENT;
  const counters = { searches: 0, opens: 0 };
  const trace = [];
  const usage = { input_tokens: 0, output_tokens: 0, cost: 0, requests: 0 };
  let text = '';
  let finish = null;
  let model = null;

  for (let round = 0; round < config.SEARCH.max_tool_rounds; round++) {
    onEvent('status', { text: round === 0 ? 'Thinking…' : 'Continuing…' });
    const r = await streamOnce({ messages: convo, maxTokens, onEvent });
    usage.requests++;
    if (r.usage) {
      usage.input_tokens += r.usage.prompt_tokens || 0;
      usage.output_tokens += r.usage.completion_tokens || 0;
      usage.cost += Number(r.usage.cost || 0);
    }
    model = r.model || model;
    finish = r.finish;
    if (r.text) text += (text ? '\n\n' : '') + r.text;

    if (r.toolCalls.length && (r.finish === 'tool_calls' || r.finish === null || r.finish === 'stop')) {
      convo.push({
        role: 'assistant', content: r.text || null,
        tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
      });
      for (const c of r.toolCalls) {
        const out = await runTool(c, counters, onEvent);
        if (out.trace) trace.push(out.trace);
        convo.push({ role: 'tool', tool_call_id: c.id, content: out.content });
      }
      continue;
    }
    break;
  }
  if (!text.trim()) {
    const err = new Error(finish === 'length' ? 'The model ran out of output tokens before writing anything.' : `The model returned no text (finish_reason: ${finish}).`);
    err.code = 'EMPTY';
    throw err;
  }
  if (finish === 'length') onEvent('status', { text: 'Output hit the token limit; the message may be cut short.' });

  const p = config.PRICES;
  const cost_usd = usage.cost || (usage.input_tokens * p.input_per_mtok + usage.output_tokens * p.output_per_mtok) / 1e6 + counters.searches * p.web_search_per_1000 / 1000;
  return { text, trace, usage: { ...usage, searches: counters.searches, opens: counters.opens }, model, stop_reason: finish, cost_usd };
}

module.exports = { runTurn };
