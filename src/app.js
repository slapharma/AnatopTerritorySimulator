'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const db = require('./db');
const prompts = require('./prompts');
const { runTurn } = require('./agents');
const exporter = require('./export');
const email = require('./email');
const { basicAuth, requireAdmin, hashPassword } = require('./auth');

const app = express();
app.use(basicAuth);
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/fonts', express.static(path.join(__dirname, '..', 'fonts')));

// marked (Markdown renderer) is served from wherever npm put it.
const markedFile = (() => {
  const root = path.dirname(require.resolve('marked'));
  for (const c of [path.join(root, '..', 'marked.min.js'), path.join(root, 'marked.umd.js'), path.join(root, '..', 'lib', 'marked.umd.js')]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
})();
app.get('/vendor/marked.js', (req, res) => {
  if (!markedFile) return res.status(500).send('marked not found');
  res.sendFile(markedFile);
});

app.get('/api/config', (req, res) => {
  res.json({
    model: config.MODEL, model_options: config.MODEL_OPTIONS, prices: config.PRICES, usd_to_gbp: config.USD_TO_GBP,
    agents: prompts.AGENTS, agent_order: prompts.AGENT_ORDER,
    input_fields: prompts.INPUT_FIELDS, base_values: prompts.BASE_VALUES,
    has_api_key: Boolean(process.env.OPENROUTER_API_KEY),
    search_provider: config.SEARCH.provider,
    rounds: prompts.rounds(),
    stance_bank: prompts.stanceBank(),
    autopilot_char_stops: config.AUTOPILOT_CHAR_STOPS,
    autopilot: config.AUTOPILOT,
    report_depth: config.REPORT_DEPTH,
    email_configured: Boolean(process.env.RESEND_API_KEY),
  });
});

app.get('/api/me', (req, res) => {
  res.json(req.user ? { authenticated: true, ...req.user } : { authenticated: false });
});

// ---------- admin: users ----------
app.get('/api/admin/users', requireAdmin, async (req, res, next) => {
  try { res.json(await db.listUsers()); } catch (e) { next(e); }
});
app.post('/api/admin/users', requireAdmin, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    if (await db.getUserByEmail(email)) return res.status(409).json({ error: 'A user with that email already exists' });
    const password_hash = await hashPassword(password);
    const user = await db.createUser({ email, password_hash, is_admin: Boolean(req.body.is_admin) });
    res.json(user);
  } catch (e) { next(e); }
});
app.patch('/api/admin/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await db.getUserById(id);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    const fields = {};
    if (typeof req.body.password === 'string' && req.body.password) fields.password_hash = await hashPassword(req.body.password);
    if (typeof req.body.is_admin === 'boolean') {
      if (existing.is_admin && !req.body.is_admin && (await db.countAdmins()) <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last remaining admin' });
      }
      fields.is_admin = req.body.is_admin;
    }
    res.json(await db.updateUser(id, fields));
  } catch (e) { next(e); }
});
app.delete('/api/admin/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await db.getUserById(id);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (existing.is_admin && (await db.countAdmins()) <= 1) return res.status(400).json({ error: 'Cannot delete the last remaining admin' });
    await db.deleteUser(id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- agent profiles (view: any authenticated user; edit: admin only) ----------
app.get('/api/agents', async (req, res, next) => {
  try { res.json(await db.listAgents()); } catch (e) { next(e); }
});
app.patch('/api/agents/:key', requireAdmin, async (req, res, next) => {
  try {
    const { description, role, knowledge, can_web_search, can_open_url } = req.body;
    const updated = await db.updateAgent(req.params.key, { description, role, knowledge, can_web_search, can_open_url });
    if (!updated) return res.status(404).json({ error: 'Unknown agent' });
    res.json(updated);
  } catch (e) { next(e); }
});

// ---------- form defaults ----------
// A stored value overrides prompts.BASE_VALUES field-by-field; an unconfigured
// field still falls back to the hardcoded example rather than coming back blank.
app.get('/api/defaults', async (req, res, next) => {
  try { res.json({ ...prompts.BASE_VALUES, ...(await db.getDefaults()) }); } catch (e) { next(e); }
});
app.patch('/api/defaults', async (req, res, next) => {
  try {
    const { key, value } = req.body;
    if (!prompts.INPUT_FIELDS.some((f) => f.key === key)) return res.status(400).json({ error: `Unknown field ${key}` });
    const stored = await db.setDefaultField(key, typeof value === 'string' ? value : '');
    res.json({ ...prompts.BASE_VALUES, ...stored });
  } catch (e) { next(e); }
});

// ---------- sessions ----------
app.get('/api/sessions', async (req, res, next) => { try { res.json(await db.listSessions()); } catch (e) { next(e); } });

app.get('/api/sessions/last-inputs', async (req, res, next) => {
  try {
    const last = await db.lastSession();
    res.json(last ? JSON.parse(last.inputs_json) : {});
  } catch (e) { next(e); }
});

app.post('/api/sessions', async (req, res, next) => {
  try {
    const inputs = {};
    for (const f of prompts.INPUT_FIELDS) inputs[f.key] = (req.body.inputs && req.body.inputs[f.key]) || '';
    const session = await db.createSession(inputs);
    if (req.body.title) await db.renameSession(session.id, req.body.title);
    res.json(await db.fullSession(session.id));
  } catch (e) { next(e); }
});

app.get('/api/sessions/:id', async (req, res, next) => {
  try {
    const s = await db.fullSession(Number(req.params.id));
    if (!s) return res.status(404).json({ error: 'Session not found' });
    res.json(s);
  } catch (e) { next(e); }
});

app.patch('/api/sessions/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await db.getSession(id))) return res.status(404).json({ error: 'Session not found' });
    if (typeof req.body.title === 'string' && req.body.title.trim()) await db.renameSession(id, req.body.title.trim());
    if (typeof req.body.model === 'string') {
      if (!config.MODEL_OPTIONS.some((m) => m.id === req.body.model)) return res.status(400).json({ error: `Unknown model ${req.body.model}` });
      await db.setModel(id, req.body.model);
    }
    if (req.body.inputs && typeof req.body.inputs === 'object') {
      const inputs = {};
      for (const f of prompts.INPUT_FIELDS) inputs[f.key] = (req.body.inputs[f.key] || '').toString();
      await db.updateInputs(id, inputs);
    }
    res.json(await db.fullSession(id));
  } catch (e) { next(e); }
});

app.delete('/api/sessions/:id', async (req, res, next) => {
  try { await db.deleteSession(Number(req.params.id)); res.json({ ok: true }); } catch (e) { next(e); }
});

app.patch('/api/sessions/:id/disagreements/:n', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const status = req.body.status === 'resolved' ? 'resolved' : 'unresolved';
    await db.setDisStatus(id, Number(req.params.n), status);
    res.json(await db.listDisagreements(id));
  } catch (e) { next(e); }
});

// ---------- autopilot runs ----------
app.post('/api/sessions/:id/autopilot-runs', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await db.getSession(id))) return res.status(404).json({ error: 'Session not found' });
    const scope = req.body.scope === 'disagreement' ? 'disagreement' : 'discussion';
    const disagreement_n = scope === 'disagreement' ? Number(req.body.disagreement_n) : null;
    const run = await db.createAutopilotRun(id, { scope, disagreement_n, settings: req.body.settings || {} });
    res.json(run);
  } catch (e) { next(e); }
});
app.patch('/api/sessions/:id/autopilot-runs/:runId', async (req, res, next) => {
  try {
    const run = await db.updateAutopilotRun(Number(req.params.runId), {
      cycles_run: req.body.cycles_run, outcome: req.body.outcome, cost_usd: req.body.cost_usd,
      ended_at: req.body.ended_at ? new Date(req.body.ended_at) : undefined,
    });
    if (!run) return res.status(404).json({ error: 'Autopilot run not found' });
    res.json(run);
  } catch (e) { next(e); }
});

// A visible, exportable note in the transcript explaining why an autopilot run
// stopped (reused for anything that needs a system-authored line, not agent turns).
app.post('/api/sessions/:id/system-note', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await db.getSession(id))) return res.status(404).json({ error: 'Session not found' });
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Empty note' });
    const speaker = String(req.body.speaker || 'autopilot');
    const msg = await db.addMessage(id, { role: 'system', speaker, mode: req.body.mode || null, text });
    res.json(msg);
  } catch (e) { next(e); }
});

// Human moderator posts a message; the client then asks each respondent to reply.
app.post('/api/sessions/:id/messages', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await db.getSession(id))) return res.status(404).json({ error: 'Session not found' });
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Empty message' });
    const to = prompts.AGENT_ORDER.includes(req.body.to) ? req.body.to : 'all';
    const msg = await db.addMessage(id, { role: 'user', speaker: 'user', mode: 'reply', addressed_to: to, text });
    const respondents = to === 'all' ? prompts.AGENT_ORDER : [to];
    res.json({ message: msg, respondents });
  } catch (e) { next(e); }
});

app.delete('/api/sessions/:id/messages/:mid', async (req, res, next) => {
  try { await db.deleteMessage(Number(req.params.mid), Number(req.params.id)); res.json({ ok: true }); } catch (e) { next(e); }
});

app.patch('/api/sessions/:id/messages/:mid/favourite', async (req, res, next) => {
  try {
    const favourite = Boolean(req.body.favourite);
    const msg = await db.setFavourite(Number(req.params.mid), Number(req.params.id), favourite);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    res.json(msg);
  } catch (e) { next(e); }
});

// ---------- agent turns (SSE over a POST) ----------
const running = new Set();

const DIS_RE = /⚠\s*\**\s*DISAGREEMENT[^\n]*\n(?:[^\n]+\n?)*/g;

async function extractDisagreements(sessionId, messageId, text) {
  const found = [];
  for (const m of text.matchAll(DIS_RE)) {
    const block = m[0].trim();
    const head = block.split('\n')[0];
    const topicMatch = head.match(/DISAGREEMENT\s*\**\s*(?:#\s*\d+)?\s*[—–:-]?\s*\[?([^\]\n]*?)\]?\**\s*$/i);
    const topic = topicMatch && topicMatch[1].trim() ? topicMatch[1].trim() : 'untitled';
    const status = /Status\s*:?\s*\**\s*RESOLVED/i.test(block) && !/Status\s*:?\s*\**\s*UNRESOLVED/i.test(block) ? 'resolved' : 'unresolved';
    found.push(await db.addDisagreement(sessionId, messageId, topic, block, status));
  }
  return found;
}

// Registers every searched / opened / cited URL as a session source and adds [n]
// markers to the text after each URL the agent cited (outside the tag brackets so
// the badge still renders).
const URL_RE = /https?:\/\/[^\s<>()\[\]"']+[^\s<>()\[\]"'.,;:!?]/g;
const TAG_RE = /\[(?:VERIFIED|ESTIMATE|UNKNOWN)\b[^\]]*\]/g;

async function assembleText(sessionId, messageId, speaker, text, trace) {
  const titles = new Map();
  for (const t of trace) {
    if (t.type === 'search') for (const r of t.results || []) { if (r.url) { titles.set(r.url, r.title); await db.upsertSource(sessionId, { url: r.url, title: r.title, kind: 'searched', messageId, speaker }); } }
    if (t.type === 'open' && t.url) { if (t.title) titles.set(t.url, t.title); await db.upsertSource(sessionId, { url: t.url, title: t.title, kind: 'cited', messageId, speaker }); }
  }
  const citeCache = new Map();
  async function cite(url) {
    if (citeCache.has(url)) return citeCache.get(url);
    const n = await db.upsertSource(sessionId, { url, title: titles.get(url), kind: 'cited', messageId, speaker });
    citeCache.set(url, n);
    return n;
  }
  // Pass 1: tags. Append [n] after the closing bracket for each URL inside.
  const tagMatches = [...text.matchAll(TAG_RE)];
  const tagReplacements = new Map();
  for (const m of tagMatches) {
    const tag = m[0];
    const nums = [];
    for (const um of tag.matchAll(URL_RE)) { const n = await cite(um[0]); if (!nums.includes(n)) nums.push(n); }
    tagReplacements.set(tag, nums.length ? `${tag} ${nums.map((n) => `[${n}]`).join('')}` : tag);
  }
  let out = text.replace(TAG_RE, (tag) => tagReplacements.get(tag));
  // Pass 2: bare URLs outside tags.
  const parts = out.split(TAG_RE);
  const tags = out.match(TAG_RE) || [];
  const newParts = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const urlMatches = [...seg.matchAll(URL_RE)];
    let s = seg;
    for (const um of urlMatches) {
      const url = um[0];
      const offset = um.index;
      const whole = seg;
      const after = whole.slice(offset + url.length, offset + url.length + 6);
      if (/^\)?\s*\[\d+\]/.test(after)) continue; // already marked
      const isMdLink = whole.slice(Math.max(0, offset - 2), offset).endsWith('](');
      if (isMdLink) continue;
      const n = await cite(url);
      s = s.replace(url, `${url} [${n}]`);
    }
    newParts.push(s + (tags[i] || ''));
  }
  out = newParts.join('');
  return out.trim();
}

// Autopilot's "Hard limit: N characters" is only a prompt instruction — small/
// free models routinely ignore it (observed: a 300-char cap produced a 2,000+
// char reply). Back it with a real truncation so the limit holds regardless of
// model compliance, while preserving the trailing POSITION line the unanimity
// check depends on. 10% slack matches what the plan's own verification allows.
function enforceCharLimit(text, maxChars) {
  if (!maxChars || maxChars === 'as_required') return text;
  const limit = Math.round(Number(maxChars) * 1.1);
  if (text.length <= limit) return text;
  const posMatch = /\n*POSITION:\s*(AGREE|DISAGREE)\s*[—-]\s*.*$/i.exec(text);
  const positionLine = posMatch ? posMatch[0].trim() : '';
  const body = posMatch ? text.slice(0, posMatch.index) : text;
  const bodyLimit = Math.max(0, limit - positionLine.length - 40);
  let cut = body.slice(0, bodyLimit);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > bodyLimit * 0.6) cut = cut.slice(0, lastSpace);
  const note = `[…truncated to the ${maxChars}-character limit]`;
  return positionLine ? `${cut.trimEnd()} ${note}\n\n${positionLine}` : `${cut.trimEnd()} ${note}`;
}

app.post('/api/sessions/:id/turn', async (req, res) => {
  const id = Number(req.params.id);
  const session = await db.fullSession(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const speaker = req.body.speaker;
  const mode = req.body.mode || 'crosstalk';
  const instruction = req.body.instruction || '';
  if (!prompts.AGENTS[speaker]) return res.status(400).json({ error: `Unknown speaker ${speaker}` });
  if (speaker === 'moderator' && !['decision', 'report'].includes(mode)) return res.status(400).json({ error: 'The moderator assistant only writes the decision output or a report' });
  if (mode === 'report' && speaker !== 'moderator') return res.status(400).json({ error: 'Only the moderator assistant writes reports' });
  // Keyed on session+speaker (not just session) so Round 1 can run all three
  // agents concurrently; still blocks the same agent double-firing.
  const runKey = `${id}:${speaker}`;
  if (running.has(runKey)) return res.status(409).json({ error: 'This agent already has a turn running for this session' });
  running.add(runKey);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  // Autopilot: resolve the stance sentence server-side from its slider index,
  // and the disagreement topic (if scoped) so the model gets a plain sentence.
  let stanceText = null;
  let disagreementTopic = null;
  if (mode === 'autopilot') {
    if (req.body.stance_index) stanceText = (prompts.stanceBank()[String(req.body.stance_index)]) || null;
    if (req.body.disagreement_n) {
      const d = session.disagreements.find((x) => x.n === Number(req.body.disagreement_n));
      disagreementTopic = d ? d.topic : null;
    }
  }

  // Reports don't join the transcript: no message row up front. Final reports
  // still get one at the end (see below) for backward compatibility.
  const isReport = mode === 'report';
  const msg = isReport ? null : await db.addMessage(id, { role: speaker === 'moderator' ? 'moderator' : 'agent', speaker, mode, text: '' });
  if (!isReport) send('start', { message_id: msg.id, seq: msg.seq, speaker, mode, created_at: msg.created_at });
  else send('start', { report: true, kind: req.body.kind, depth: req.body.depth });
  const searches = [];
  const turnStarted = Date.now();
  try {
    const result = await runTurn({
      inputs: session.inputs, agentKey: speaker, mode, instruction, messages: session.messages,
      model: session.model || config.MODEL,
      max_chars: req.body.max_chars, stance: stanceText, disagreementTopic,
      report: isReport ? {
        kind: req.body.kind === 'final' ? 'final' : 'interim',
        depth: ['brief', 'standard', 'full'].includes(req.body.depth) ? req.body.depth : 'standard',
        meta: {
          disagreements: session.disagreements, autopilotRuns: session.autopilot_runs,
          sourcesCount: session.sources.length, inputs: session.inputs,
        },
      } : undefined,
      onEvent: (name, payload) => { if (name === 'search') searches.push(payload.query); send(name, payload); },
    });

    if (isReport) {
      const kind = req.body.kind === 'final' ? 'final' : 'interim';
      const depth = ['brief', 'standard', 'full'].includes(req.body.depth) ? req.body.depth : 'standard';
      // No message row backs a report (except Final, added below), so pass no
      // message id to link citations to — reports still get [n] markers against
      // the session's existing source list, just without a "first seen here" link.
      const text = await assembleText(id, null, 'moderator', result.text, result.trace);
      const report = await db.addReport(id, {
        kind, depth, text, model: result.model, cost_usd: result.cost_usd,
        created_by: (req.user && req.user.email) || null,
      });
      // Backward compat: a Final report still leaves a transcript message and
      // mirrors to sessions.decision_text, so old sessions/exports render unchanged.
      let finalMessage = null;
      if (kind === 'final') {
        const finalMsg = await db.addMessage(id, { role: 'moderator', speaker: 'moderator', mode: 'decision', text });
        await db.updateMessage(finalMsg.id, {
          text, content_json: JSON.stringify({ model: result.model, trace: result.trace, usage: result.usage, report_id: report.id }),
          input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens, cache_read_tokens: 0, cache_write_tokens: 0,
          searches: result.usage.searches, cost_usd: result.cost_usd, error: null, duration_ms: Date.now() - turnStarted,
        });
        await db.setDecision(id, text);
        finalMessage = await db.getMessage(finalMsg.id);
      }
      await db.touchSession(id);
      send('done', { report, message: finalMessage });
      running.delete(runKey);
      return res.end();
    }

    let text = await assembleText(id, msg.id, speaker, result.text, result.trace);
    if (mode === 'autopilot') text = enforceCharLimit(text, req.body.max_chars);
    const u = result.usage;
    await db.updateMessage(msg.id, {
      text, content_json: JSON.stringify({
        model: result.model, trace: result.trace, usage: u,
        ...(mode === 'autopilot' ? { max_chars: req.body.max_chars, stance_index: req.body.stance_index, autopilot: req.body.autopilot } : {}),
      }),
      input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_tokens: 0, cache_write_tokens: 0,
      searches: u.searches, cost_usd: result.cost_usd, error: null, duration_ms: Date.now() - turnStarted,
    });
    const disagreements = await extractDisagreements(id, msg.id, text);
    if (mode === 'decision') await db.setDecision(id, text);
    await db.touchSession(id);
    const [message, sources, allDisagreements] = await Promise.all([
      db.getMessage(msg.id), db.listSources(id), db.listDisagreements(id),
    ]);
    send('done', {
      message,
      sources: sources.map((s) => ({ ...s, cited_by: JSON.parse(s.cited_by_json) })),
      disagreements: allDisagreements,
      new_disagreements: disagreements,
      searches,
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`[turn ${msg ? msg.id : 'report'}] ${speaker}/${mode} failed:`, message);
    if (msg) {
      await db.updateMessage(msg.id, {
        text: '', content_json: null, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
        searches: 0, cost_usd: 0, error: message, duration_ms: Date.now() - turnStarted,
      });
    }
    send('error', { message_id: msg ? msg.id : null, message, code: err.code || (err.status ? `HTTP ${err.status}` : 'ERROR') });
  } finally {
    running.delete(runKey);
    res.end();
  }
});

// ---------- reports ----------
app.get('/api/sessions/:id/reports', async (req, res, next) => {
  try { res.json(await db.listReports(Number(req.params.id))); } catch (e) { next(e); }
});
app.get('/api/sessions/:id/reports/:rid', async (req, res, next) => {
  try {
    const r = await db.getReport(Number(req.params.rid), Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'Report not found' });
    res.json(r);
  } catch (e) { next(e); }
});
app.delete('/api/sessions/:id/reports/:rid', async (req, res, next) => {
  try { await db.deleteReport(Number(req.params.rid), Number(req.params.id)); res.json({ ok: true }); } catch (e) { next(e); }
});

async function loadReportForExport(req, res) {
  const s = await db.fullSession(Number(req.params.id));
  if (!s) { res.status(404).send('Session not found'); return null; }
  const report = await db.getReport(Number(req.params.rid), s.id);
  if (!report) { res.status(404).send('Report not found'); return null; }
  return { s, report };
}
app.get('/api/sessions/:id/reports/:rid/export.docx', async (req, res, next) => {
  try {
    const loaded = await loadReportForExport(req, res);
    if (!loaded) return;
    const buf = await exporter.toDocx(loaded.s, { report: loaded.report });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${exporter.reportFileName(loaded.s, loaded.report)}.docx"`);
    res.send(buf);
  } catch (e) { next(e); }
});
app.get('/api/sessions/:id/reports/:rid/export.pdf', async (req, res, next) => {
  try {
    const loaded = await loadReportForExport(req, res);
    if (!loaded) return;
    const buf = await exporter.toPdf(loaded.s, { report: loaded.report });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${exporter.reportFileName(loaded.s, loaded.report)}.pdf"`);
    res.send(buf);
  } catch (e) { next(e); }
});

app.post('/api/sessions/:id/reports/:rid/email', async (req, res, next) => {
  try {
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'Email not configured (RESEND_API_KEY is not set)' });
    const loaded = await loadReportForExport(req, res);
    if (!loaded) return;
    const { s, report } = loaded;
    const to = Array.isArray(req.body.to) ? req.body.to.map((x) => String(x).trim()).filter(Boolean) : [];
    if (!to.length) return res.status(400).json({ error: 'At least one recipient is required' });
    const format = ['pdf', 'docx', 'both'].includes(req.body.format) ? req.body.format : 'pdf';
    const attachments = [];
    if (format === 'pdf' || format === 'both') attachments.push({ filename: `${exporter.reportFileName(s, report)}.pdf`, content: await exporter.toPdf(s, { report }) });
    if (format === 'docx' || format === 'both') attachments.push({ filename: `${exporter.reportFileName(s, report)}.docx`, content: await exporter.toDocx(s, { report }) });
    const sentBy = (req.user && req.user.email) || null;
    const result = await email.sendReportEmail({ session: s, report, to, attachments, note: req.body.note || '', sentBy });
    const row = await db.addReportEmail(report.id, { to, format, sent_by: sentBy, provider_id: result.id });
    res.json({ ok: true, provider_id: result.id, row });
  } catch (e) { next(e); }
});

// ---------- exports ----------
app.get('/api/sessions/:id/export.docx', async (req, res, next) => {
  try {
    const s = await db.fullSession(Number(req.params.id));
    if (!s) return res.status(404).send('Session not found');
    const buf = await exporter.toDocx(s);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${exporter.fileName(s)}.docx"`);
    res.send(buf);
  } catch (e) { next(e); }
});
app.get('/api/sessions/:id/export.pdf', async (req, res, next) => {
  try {
    const s = await db.fullSession(Number(req.params.id));
    if (!s) return res.status(404).send('Session not found');
    const buf = await exporter.toPdf(s);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${exporter.fileName(s)}.pdf"`);
    res.send(buf);
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: err.message || String(err) });
});

if (!process.env.VERCEL) {
  app.listen(config.PORT, () => {
    console.log(`Anatop Territory Evaluation running at http://localhost:${config.PORT}`);
    console.log(`Model: ${config.MODEL}`);
    console.log(`Search: ${config.SEARCH.provider}`);
    if (!process.env.OPENROUTER_API_KEY) console.log('WARNING: OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your key.');
  });
}

module.exports = app;
