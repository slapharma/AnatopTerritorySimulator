// Runs one whole evaluation through the app's own code (prompts, agents.runTurn
// with its tools, transcript.assembleText, the evidence check, the disagreement
// and question parsers, minutes, the answered-check and a Final report) against
// an IN-MEMORY database, then reports how evidenced the result is.
//
// It never reads DATABASE_URL, so it cannot touch the production database the
// repo's .env points at. It does call OpenRouter and the search provider with
// the keys in that .env, so it costs real (small) money: about $0.03 a session
// on the default model when measured on 2026-09-24.
//
//   node scripts/simulate-session.js [--model id] [--country name] [--depth brief|standard|full]
//                                    [--out dir] [--env path/to/.env] [--probe]
//
// --probe also fetches every cited URL that no agent searched or opened, to see
// whether it exists. Output: <out>/session.json, transcript.md, metrics.json.
'use strict';
require('../src/bootstrap');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

// Only the two API keys are taken from the env file; the database URL never is.
const envPath = arg('env', path.join(ROOT, '.env'));
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(OPENROUTER_API_KEY|TAVILY_API_KEY|BRAVE_API_KEY)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
delete process.env.DATABASE_URL;

// ---------- in-memory db: only what prompts.js and transcript.js touch ----------
const sources = new Map();
function mergeKind(a, b) {
  if (a === b) return a;
  if (a === 'cited' || b === 'cited') return 'cited';
  if ((a === 'searched' && b === 'unverified') || (a === 'unverified' && b === 'searched')) return 'cited';
  return a || b;
}
const kbItems = (() => {
  // The curated Drive index the agents are shown, parsed as scripts/import-knowledgebase.js does.
  const file = path.join(ROOT, 'agent knowledgebase', 'drive-document-index.md');
  if (!fs.existsSync(file)) return [];
  const items = [];
  let cat = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cat = /^Skipped \/ low relevance/i.test(h[1]) ? null : /^Handle with care/i.test(h[1]) ? 'Commercial — pricing, forecasts and partner terms' : h[1]; continue; }
    if (!cat || !/^\s*-\s/.test(line)) continue;
    const note = (line.split(/\s—\s/).slice(1).join(' — ') || '').trim().slice(0, 240);
    for (const l of line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) items.push({ category: cat, title: l[1], url: l[2], note });
  }
  return items;
})();
const fakeDb = {
  pool: { on() {} },
  getAgent: async () => null,
  listKnowledgeItems: async () => kbItems,
  upsertSource: async (sid, { url, title, kind, messageId, speaker }) => {
    const ex = sources.get(url);
    if (ex) {
      if (!ex.cited_by.some((c) => c.message_id === messageId)) ex.cited_by.push({ message_id: messageId, speaker });
      ex.kind = mergeKind(ex.kind, kind);
      if (title) ex.title = title;
      return ex.n;
    }
    const n = sources.size + 1;
    sources.set(url, { n, url, title: title || null, kind, cited_by: [{ message_id: messageId, speaker }] });
    return n;
  },
};
const dbPath = require.resolve(path.join(ROOT, 'src', 'db'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: new Proxy(fakeDb, { get: (t, k) => (k in t ? t[k] : async () => []) }) };

const config = require('../src/config');
const prompts = require('../src/prompts');
const { runTurn } = require('../src/agents');
const { assembleText } = require('../src/transcript');
const evidence = require('../src/evidence');
const questions = require('../src/questions');
const { parseDisagreements, openDisagreementsMarkdown, dropSection } = require('../src/disagreements');

const model = arg('model', config.MODEL);
const country = arg('country', prompts.BASE_VALUES.country);
const depth = arg('depth', 'standard');
const out = path.resolve(arg('out', path.join(ROOT, 'exports', `simulation-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`)));
fs.mkdirSync(out, { recursive: true });

const inputs = { ...prompts.BASE_VALUES, country };
const messages = [];
const disagreements = [];
const qs = [];
const minutes = [];
const reports = [];
let nextId = 1;
const label = (k) => (prompts.AGENTS[k] ? prompts.AGENTS[k].label : k);
const log = (s) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`; console.log(line); fs.appendFileSync(path.join(out, 'progress.log'), `${line}\n`); };

function logDisagreements(seq, text) {
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const d of parseDisagreements(text)) {
    const ex = norm(d.topic) !== 'untitled' && disagreements.find((x) => norm(x.topic) === norm(d.topic));
    if (ex) Object.assign(ex, { status: d.status, body: d.block, message_seq: seq });
    else disagreements.push({ n: disagreements.length + 1, topic: d.topic, status: d.status, body: d.block, message_seq: seq });
  }
}

function save() {
  fs.writeFileSync(path.join(out, 'session.json'), JSON.stringify({ inputs, model, messages, disagreements, questions: qs, minutes, reports, sources: [...sources.values()] }, null, 1));
  const md = [`# Simulated evaluation — ${inputs.country} — ${model}`, ''];
  for (const m of messages) {
    const r = (m.content_json && m.content_json.research) || {};
    md.push('---', '', `## [${m.seq}] ${label(m.speaker)} · ${m.mode} · searches ${r.searches ?? 0}, pages read ${r.opens ?? 0}${r.nudges && r.nudges.length ? `, corrections sent: ${r.nudges.join(', ')}` : ''}`, '', m.error ? `ERROR: ${m.error}` : m.text, '');
  }
  for (const x of minutes) md.push('---', '', `## Minutes — ${x.label}`, '', x.text, '');
  for (const x of reports) md.push('---', '', `## Final report (${x.depth})`, '', x.error ? `ERROR: ${x.error}` : x.text, '');
  fs.writeFileSync(path.join(out, 'transcript.md'), md.join('\n'));
}

async function agentTurn(speaker, mode) {
  const row = { id: nextId++, seq: messages.length + 1, role: 'agent', speaker, mode, text: null, error: null, created_at: new Date().toISOString() };
  messages.push(row);
  const earlier = messages.filter((m) => m !== row && m.text);
  const started = Date.now();
  try {
    const ctx = evidence.sessionContext(earlier);
    const r = await runTurn({ inputs, agentKey: speaker, mode, messages: earlier, disagreements, model, evidenceCtx: ctx, onEvent: () => {} });
    const assembled = await assembleText(1, row.id, speaker, r.text, r.trace, { ...ctx, pages: r.pages });
    row.text = assembled.text;
    row.content_json = { model: r.model, trace: r.trace, usage: r.usage, stop_reason: r.stop_reason, evidence: assembled.evidence, research: r.research };
    row.cost_usd = r.cost_usd;
    logDisagreements(row.seq, row.text);
    for (const it of questions.parseQuestions(row.text, Object.fromEntries(prompts.AGENT_ORDER.map((k) => [k, prompts.AGENTS[k]])), speaker)) {
      qs.push({ id: qs.length + 1, message_seq: row.seq, asker: speaker, addressees: it.addressees.join(','), round: mode, status: 'open', text: it.text });
    }
    const e = assembled.evidence.counts;
    log(`${speaker}/${mode}: ${r.research.searches} searches, ${r.research.opens} opens, nudges [${r.research.nudges.join(',')}], VERIFIED ${e.verified} / downgraded ${e.downgraded} / ESTIMATE ${e.estimate} / UNKNOWN ${e.unknown} / INTERNAL ${e.internal}, ${Math.round((Date.now() - started) / 1000)}s, $${Number(r.cost_usd || 0).toFixed(4)}`);
  } catch (err) {
    row.error = err.message;
    log(`${speaker}/${mode} FAILED: ${err.message}`);
  }
  save();
}

async function moderator(mode, extra = {}) {
  const earlier = messages.filter((m) => m.text);
  const r = await runTurn({ inputs, agentKey: 'moderator', mode, messages: earlier, disagreements, model, onEvent: () => {}, ...extra });
  return { r, ctx: { ...evidence.sessionContext(earlier), pages: r.pages } };
}

async function minutesFor(name) {
  try {
    const { r, ctx } = await moderator('meeting_minutes', { instruction: name });
    const { text } = await assembleText(1, null, 'moderator', dropSection(r.text, /^open disagreements\b/i), r.trace, ctx, { register: false });
    minutes.push({ label: name, text: `${text.trim()}\n\n${openDisagreementsMarkdown(disagreements)}` });
  } catch (err) { minutes.push({ label: name, text: `ERROR: ${err.message}` }); }
  save();
}

async function questionsCheck() {
  const open = qs.filter((x) => x.status === 'open' && !x.addressees.split(',').includes('moderator'));
  if (!open.length) return;
  const list = open.map((x) => `- id ${x.id} · asked by ${label(x.asker)} in message [${x.message_seq}] to ${x.addressees.split(',').map(label).join(' and ')}: ${x.text.replace(/\s+/g, ' ')}`).join('\n');
  try {
    const { r } = await moderator('questions_check', { instruction: list });
    for (const a of questions.parseAnsweredCheck(r.text)) {
      const q = open.find((x) => String(x.id) === a.id);
      if (q && a.seq > q.message_seq) Object.assign(q, { status: 'answered', answered_seq: a.seq, note: a.note });
    }
  } catch (err) { log(`questions_check FAILED: ${err.message}`); }
  save();
}

async function finalReport() {
  const register = evidence.evidenceRegister(messages, label);
  const opened = evidence.sessionContext(messages).opened;
  const counts = { opened: opened.size, cited: 0, searched: 0, unverified: 0 };
  for (const s of sources.values()) if (s.kind in counts) counts[s.kind]++;
  try {
    const { r, ctx } = await moderator('report', { report: { kind: 'final', depth, meta: { disagreements, autopilotRuns: [], sources: counts, evidence: register, inputs } } });
    const body = `${r.text.trim()}\n\n${evidence.registerMarkdown(register, depth)}`;
    const { text, evidence: ev } = await assembleText(1, null, 'moderator', body, r.trace, ctx);
    reports.push({ kind: 'final', depth, text, evidence: ev, cost_usd: r.cost_usd });
    log(`final report (${depth}): ${text.length} chars, $${Number(r.cost_usd || 0).toFixed(4)}`);
  } catch (err) {
    reports.push({ kind: 'final', depth, error: err.message });
    log(`final report FAILED: ${err.message}`);
  }
  save();
}

async function probe(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LaunchWorkingGroup-simulation/1.0' } });
    return res.status;
  } catch (e) { return e.name === 'AbortError' ? 'timeout' : 'failed'; } finally { clearTimeout(t); }
}

async function metrics() {
  const rows = messages.map((m) => {
    const c = m.content_json || {};
    return { seq: m.seq, speaker: m.speaker, mode: m.mode, error: m.error || undefined, ...(c.research || {}), ...evidence.countTags(m.text || '') };
  });
  const unverified = [...sources.values()].filter((s) => s.kind === 'unverified');
  const result = {
    model, country, depth,
    turns: rows.length,
    failed_turns: rows.filter((r) => r.error).length,
    research_turns_without_search: rows.filter((r) => r.required && !r.searches).length,
    totals: evidence.evidenceRegister(messages, label).totals,
    sources: { total: sources.size, unverified: unverified.length },
    disagreements: disagreements.length,
    questions: qs.length,
    cost_usd: messages.reduce((n, m) => n + Number(m.cost_usd || 0), 0) + reports.reduce((n, r) => n + Number(r.cost_usd || 0), 0),
    per_turn: rows,
  };
  if (flag('probe')) result.unverified_links = await Promise.all(unverified.map(async (s) => ({ url: s.url, status: await probe(s.url) })));
  fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify(result, null, 1));
  return result;
}

(async () => {
  if (!process.env.OPENROUTER_API_KEY) throw new Error(`OPENROUTER_API_KEY not found (looked in the environment and ${envPath}).`);
  log(`START model=${model} country=${country} depth=${depth} out=${out}`);
  await Promise.allSettled(prompts.AGENT_ORDER.map((a) => agentTurn(a, 'opening')));
  await minutesFor('Round 1 — Baselines');
  for (const a of prompts.AGENT_ORDER) await agentTurn(a, 'round2');
  await minutesFor('Round 2 — Challenge');
  await questionsCheck();
  for (const a of prompts.AGENT_ORDER) await agentTurn(a, 'round3');
  await minutesFor('Round 3 — Converge');
  await questionsCheck();
  await finalReport();
  const m = await metrics();
  log(`END ${JSON.stringify({ turns: m.turns, failed: m.failed_turns, unresearched: m.research_turns_without_search, totals: m.totals, sources: m.sources, cost_usd: Number(m.cost_usd.toFixed(4)) })}`);
})().catch((e) => { log(`FATAL ${e.stack || e.message}`); process.exit(1); });
