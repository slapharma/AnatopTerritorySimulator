'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const db = require('./db');
const prompts = require('./prompts');
const { assembleText } = require('./transcript');
const { runTurn } = require('./agents');
const exporter = require('./export');
const intelExport = require('./intel-export');
const email = require('./email');
const questions = require('./questions');
const usage = require('./usage');
const { sendMeetingMinutesEmail } = email;
const auth = require('./auth');
const { authenticate, requireAdmin, hashPassword } = auth;

const app = express();

// Above authenticate on purpose: a signed-out visitor has to be able to load
// this. It carries no data, so serving it unauthenticated leaks nothing.
//
// Clearing the session cookie is a real sign-out, which Basic auth never had —
// the browser cached that credential and replayed it until it was closed. Any
// Basic credential a script still sends keeps working, by design.
app.get('/logout', (req, res) => {
  auth.clearSessionCookie(req, res);
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signed out</title><link rel="stylesheet" href="/styles.css">
<style>
  body { display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; background: var(--bg); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 28px; max-width: 380px; box-shadow: var(--shadow); }
  h1 { font-size: 17px; margin: 0 0 6px; }
  p { font-size: 13.5px; line-height: 1.55; color: var(--text-2); margin: 0 0 16px; }
</style></head><body>
  <div class="card">
    <h1>Signed out</h1>
    <p>Your session has ended. Sign in again to carry on.</p>
    <a class="btn btn-primary" href="/login">Sign in</a>
  </div>
</body></html>`);
});

// ---------------------------------------------------------------- sign-in
// These four sit above authenticate because a signed-out visitor has to be able
// to reach them. express.json is mounted app-wide below, so the POST gets its
// own parser here, with a small limit: nothing legitimate posted to /login is
// larger than a couple of hundred bytes.
const loginBody = express.json({ limit: '4kb' });

// The sign-in page needs its stylesheet, the wordmark and the fonts, and every
// one of those is served by the static mount BELOW authenticate — so without
// this the page renders as unstyled Times on white for exactly the people who
// have not signed in yet. Only these three are exposed, and none carries data.
// dotfiles:'allow' for the same reason as the vendor routes below: `send`
// 404s any absolute path containing a dot-segment, and this repo lives under
// .CLAUDE-Projects, so without it these are 404 on this machine.
const publicAsset = (rel) => (req, res) => res.sendFile(path.join(__dirname, '..', rel), { dotfiles: 'allow' });
app.get('/styles.css', publicAsset('web/styles.css'));
app.get('/sla-logo.png', publicAsset('web/sla-logo.png'));
app.use('/fonts', express.static(path.join(__dirname, '..', 'fonts')));

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'web', 'login.html'), { dotfiles: 'allow' });
});

// Lets the page say "sign-in is unconfigured" rather than failing silently.
app.get('/api/login-status', (req, res) => {
  res.json({ form_login: auth.formLoginAvailable() });
});

app.post('/login', loginBody, async (req, res) => {
  try {
    // The same per-IP throttle the middleware uses; the form must not be a way
    // around it, since it is the easier of the two endpoints to script against.
    if (auth.isLockedOut(req.ip)) {
      return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again in a few minutes.' });
    }
    if (!auth.formLoginAvailable()) {
      return res.status(503).json({ error: 'Sign-in by form is not configured on this server (AUTH_SECRET is unset).' });
    }
    const { email, password } = req.body || {};
    const user = await auth.checkCredentials(req.ip, email, password);
    // One message for "no such user" and for "wrong password": saying which
    // would let anyone enumerate who has an account here.
    if (!user) return res.status(401).json({ error: 'Email or password is incorrect.' });
    auth.setSessionCookie(req, res, auth.mintSession(user));
    res.json({ ok: true, email: user.email, is_admin: user.is_admin });
  } catch (e) {
    console.error('[login] failed:', e);
    res.status(500).json({ error: 'Could not sign you in. Try again.' });
  }
});

app.post('/logout', (req, res) => {
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.use(authenticate);
app.use(express.json({ limit: '4mb' }));
// The front end lives in web/, NOT public/. Vercel serves a root-level public/
// straight off its CDN, matching it before any rewrite reaches this function —
// so while these files sat there, every page and asset was fetchable without
// credentials even though basicAuth is mounted above express.static. Renaming
// the directory is the fix: nothing is a static output any more, so /(.*) falls
// through to the rewrite and every request is authenticated here.
app.use(express.static(path.join(__dirname, '..', 'web')));
app.use('/fonts', express.static(path.join(__dirname, '..', 'fonts')));

// marked (Markdown renderer) is served from wherever npm put it.
const markedFile = (() => {
  const root = path.dirname(require.resolve('marked'));
  for (const c of [path.join(root, '..', 'marked.min.js'), path.join(root, 'marked.umd.js'), path.join(root, '..', 'lib', 'marked.umd.js')]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
})();
// dotfiles:'allow' — `send` otherwise 404s any absolute path containing a
// dot-directory segment (e.g. a checkout under .CLAUDE-Projects).
app.get('/vendor/marked.js', (req, res) => {
  if (!markedFile) return res.status(500).send('marked not found');
  res.sendFile(markedFile, { dotfiles: 'allow' });
});

// DOMPurify sanitizes marked's output before it hits innerHTML (marked itself
// does not sanitize — agent/human message text is otherwise a stored-XSS vector).
const dompurifyFile = (() => {
  try {
    const root = path.dirname(require.resolve('dompurify'));
    for (const c of [path.join(root, 'purify.min.js'), path.join(root, 'dist', 'purify.min.js')]) {
      if (fs.existsSync(c)) return c;
    }
  } catch { /* not installed yet */ }
  return null;
})();
app.get('/vendor/dompurify.js', (req, res) => {
  if (!dompurifyFile) return res.status(500).send('dompurify not found');
  res.sendFile(dompurifyFile, { dotfiles: 'allow' });
});

app.get('/api/config', (req, res) => {
  res.json({
    model: config.MODEL, model_options: config.MODEL_OPTIONS, prices: config.PRICES, usd_to_gbp: config.USD_TO_GBP,
    agents: prompts.AGENTS, agent_order: prompts.AGENT_ORDER,
    input_fields: prompts.INPUT_FIELDS, base_values: prompts.BASE_VALUES,
    has_api_key: Boolean(process.env.OPENROUTER_API_KEY),
    search_provider: config.SEARCH.provider,
    rounds: prompts.rounds(),
    stance_bank: prompts.STANCE,
    autopilot_char_stops: config.AUTOPILOT_CHAR_STOPS,
    autopilot: config.AUTOPILOT,
    report_depth: config.REPORT_DEPTH,
    turn_timeout_ms: config.TURN_TIMEOUT_MS,
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
// Persona/questions/CV text is file-backed (prompts/agents/<key>/) so it's
// reviewable in git; each row here is the editable overlay (knowledge,
// abilities, challenge level) plus a read-only preview of the file text.
app.get('/api/agents', async (req, res, next) => {
  try {
    // Driven by the roster manifest, not by what happens to be in the agents
    // table: an agent added to prompts/agents/index.json has no row until
    // someone edits its overlay, and it still belongs on this page.
    const rows = await db.listAgents();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    res.json(prompts.AGENT_ORDER.map((key) => ({
      key,
      knowledge: '', can_web_search: true, can_open_url: true, stance_default: 3,
      ...(byKey.get(key) || {}),
      // After the row, not before it: agents.label is a legacy column seeded at
      // install and never updated, so a row written before an agent was renamed
      // would otherwise put the old name back on this page. The manifest is the
      // only source of the label.
      label: prompts.AGENTS[key].label,
      persona_preview: prompts.personaFilesRaw(key),
      // The checked-in prompts/agents/<key>/knowledge.md. `knowledge` above
      // overrides it; empty means this default is what the agent actually gets,
      // which the page shows as placeholder text rather than an empty box.
      knowledge_default: prompts.knowledgeDefault(key),
    })));
  } catch (e) { next(e); }
});
app.get('/api/stance-levels', (req, res) => res.json(prompts.STANCE));
app.patch('/api/agents/:key', requireAdmin, async (req, res, next) => {
  try {
    const { knowledge, can_web_search, can_open_url, stance_default } = req.body;
    const updated = await db.updateAgent(req.params.key, { knowledge, can_web_search, can_open_url, stance_default });
    if (!updated) return res.status(404).json({ error: 'Unknown agent' });
    res.json({
      ...updated,
      persona_preview: prompts.AGENTS[updated.key] ? prompts.personaFilesRaw(updated.key) : null,
      knowledge_default: prompts.AGENTS[updated.key] ? prompts.knowledgeDefault(updated.key) : '',
    });
  } catch (e) { next(e); }
});

// ---------- knowledgebase (view: any authenticated user; edit: admin only) ----------
app.get('/api/knowledge', async (req, res, next) => {
  try { res.json(await db.listKnowledgeItems()); } catch (e) { next(e); }
});
app.post('/api/knowledge', requireAdmin, async (req, res, next) => {
  try {
    const category = String(req.body.category || '').trim();
    const title = String(req.body.title || '').trim();
    const url = String(req.body.url || '').trim();
    if (!category || !title || !url) return res.status(400).json({ error: 'category, title and url are required' });
    const item = await db.createKnowledgeItem({ category, title, url, note: req.body.note, sensitive: req.body.sensitive });
    res.json(item);
  } catch (e) { next(e); }
});
app.patch('/api/knowledge/:id', requireAdmin, async (req, res, next) => {
  try {
    const { category, title, url, note, sensitive } = req.body;
    const updated = await db.updateKnowledgeItem(Number(req.params.id), { category, title, url, note, sensitive });
    if (!updated) return res.status(404).json({ error: 'Item not found' });
    res.json(updated);
  } catch (e) { next(e); }
});
app.delete('/api/knowledge/:id', requireAdmin, async (req, res, next) => {
  try { await db.deleteKnowledgeItem(Number(req.params.id)); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---------- form defaults ----------
// A stored value overrides prompts.BASE_VALUES field-by-field; an unconfigured
// field still falls back to the hardcoded example rather than coming back blank.
// Stored values for a field that has since been removed from the form are not
// served: nothing renders them, and handing them to the client would put keys
// in the form payload that the PATCH route then rejects as unknown.
// scripts/prune-defaults.js clears them from the row itself.
function knownDefaults(stored) {
  const out = {};
  for (const f of prompts.INPUT_FIELDS) if (f.key in stored) out[f.key] = stored[f.key];
  return out;
}
app.get('/api/defaults', async (req, res, next) => {
  try { res.json({ ...prompts.BASE_VALUES, ...knownDefaults(await db.getDefaults()) }); } catch (e) { next(e); }
});
app.patch('/api/defaults', requireAdmin, async (req, res, next) => {
  try {
    const { key, value } = req.body;
    if (!prompts.INPUT_FIELDS.some((f) => f.key === key)) return res.status(400).json({ error: `Unknown field ${key}` });
    const stored = await db.setDefaultField(key, typeof value === 'string' ? value : '');
    res.json({ ...prompts.BASE_VALUES, ...knownDefaults(stored) });
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

// The model is picked by whoever fills in the New Evaluation form, so it arrives
// from the browser on both the create and the update path and has to be checked
// on both. Returns null when the choice is allowed, or {status, error} to send.
// Paid models cost real OpenRouter spend with no per-user budget check anywhere
// else in the app — restrict picking one to admins.
function modelRefusal(model, user) {
  const opt = config.MODEL_OPTIONS.find((m) => m.id === model);
  if (!opt) return { status: 400, error: `Unknown model ${model}` };
  if (!opt.free && !(user && user.is_admin)) return { status: 403, error: 'Only an admin can select a paid model' };
  return null;
}

app.post('/api/sessions', async (req, res, next) => {
  try {
    const inputs = {};
    for (const f of prompts.INPUT_FIELDS) inputs[f.key] = (req.body.inputs && req.body.inputs[f.key]) || '';
    // An empty PRODUCT/COUNTRY still runs all three agents (each turn just
    // reports "INPUT MISSING" for both) — real API spend for a session nobody
    // can act on. Required fields the client also enforces, checked again here
    // since this is the actual point of no return.
    if (!inputs.product.trim() || !inputs.country.trim()) {
      return res.status(400).json({ error: 'PRODUCT and COUNTRY are required to start a session.' });
    }
    // No model sent means "use the default" — stored as null, which agents.js
    // reads as config.MODEL, so the default keeps tracking config rather than
    // being frozen into the row at creation time.
    let model;
    if (typeof req.body.model === 'string' && req.body.model.trim()) {
      const refusal = modelRefusal(req.body.model, req.user);
      if (refusal) return res.status(refusal.status).json({ error: refusal.error });
      model = req.body.model;
    }
    const session = await db.createSession(inputs, model, req.user && req.user.id);
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
    const existing = await db.getSession(id);
    if (!existing) return res.status(404).json({ error: 'Session not found' });
    if (typeof req.body.title === 'string' && req.body.title.trim()) await db.renameSession(id, req.body.title.trim());
    if (typeof req.body.model === 'string') {
      const refusal = modelRefusal(req.body.model, req.user);
      if (refusal) return res.status(refusal.status).json({ error: refusal.error });
      // The model can change mid-evaluation, so the switch is written into the
      // transcript: without it one session would span two models with nothing
      // on the page or in the export saying where the change happened.
      const name = (m) => (config.MODEL_OPTIONS.find((o) => o.id === m) || { label: m }).label.replace(/\s*\(.*$/, '');
      await db.switchModel(id, req.body.model, (from, to) => `Model changed from ${name(from)} to ${name(to)}. Turns from here on run on ${name(to)}.`);
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
  try {
    const id = Number(req.params.id);
    const session = await db.getSession(id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    // Sessions are shared/collaborative by design (regulatory/clinical/commercial
    // + a human moderator working the same evaluation) — only deletion is
    // gated, so no one can wipe someone else's session. A legacy session with
    // no recorded owner stays deletable by anyone, matching prior behavior.
    const canDelete = !req.user || !session.owner_id || req.user.is_admin || session.owner_id === req.user.id;
    if (!canDelete) return res.status(403).json({ error: 'Only this session\'s creator or an admin can delete it' });
    await db.deleteSession(id);
    res.json({ ok: true });
  } catch (e) { next(e); }
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
    const scope = ['disagreement', 'question'].includes(req.body.scope) ? req.body.scope : 'discussion';
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

// ⚠️? tolerates the emoji-presentation variation selector (⚠️) the model
// sometimes emits instead of bare ⚠. [\s\S]*? (not [^\n]*) so a blank line
// between Position A/B/Status — required by the FORMATTING RULES above —
// doesn't truncate the block before Status is reached.
const DIS_RE = /⚠️?\s*\**\s*DISAGREEMENT[\s\S]*?Status\s*:?\s*\**\s*(?:RESOLVED|UNRESOLVED)[^\n]*/g;

async function extractDisagreements(sessionId, messageId, text) {
  const found = [];
  for (const m of text.matchAll(DIS_RE)) {
    const block = m[0].trim();
    const head = block.split('\n')[0];
    const topicMatch = head.match(/DISAGREEMENT\s*\**\s*(?:#\s*\d+)?\s*[—–:-]?\s*\[?([^\]\n]*?)\]?\**\s*$/i);
    const topic = topicMatch && topicMatch[1].trim() ? topicMatch[1].trim() : 'untitled';
    const status = /Status\s*:?\s*\**\s*RESOLVED/i.test(block) && !/Status\s*:?\s*\**\s*UNRESOLVED/i.test(block) ? 'resolved' : 'unresolved';
    found.push(await db.upsertDisagreement(sessionId, messageId, topic, block, status));
  }
  return found;
}

// ---------- agent questions ----------
// The panel agents only (prompts.AGENTS also carries the moderator assistant).
const panelAgents = () => Object.fromEntries(prompts.AGENT_ORDER.map((k) => [k, prompts.AGENTS[k]]));
const agentLabel = (key) => (key === 'moderator' ? 'the Moderator' : (prompts.AGENTS[key] ? prompts.AGENTS[key].label : key));

// One llm_calls row per runTurn, success or failure (src/usage.js). `outcome`
// is runTurn's result, or the error it threw, which carries the usage spent
// before it failed. Never throws: losing a usage row must not fail the turn,
// and the row's absence only means summarise() falls back to the message's own
// cost figures.
async function recordLlmCall(req, sessionId, { classification, speaker, requestedModel, outcome, error, message_id, report_id, started }) {
  const u = (outcome && outcome.usage) || {};
  try {
    await db.addLlmCall(sessionId, {
      ...classification, speaker,
      model: (outcome && outcome.model) || requestedModel || null,
      message_id: message_id ?? null, report_id: report_id ?? null,
      requests: u.requests, input_tokens: u.input_tokens, output_tokens: u.output_tokens, searches: u.searches,
      cost_usd: Number((outcome && outcome.cost_usd) || 0),
      duration_ms: started ? Date.now() - started : null,
      error: error ? String(error).slice(0, 1000) : null,
      created_by: (req.user && req.user.email) || null,
    });
  } catch (e) {
    console.error(`[llm_calls] session ${sessionId}: could not record ${classification.feature} usage:`, e.message);
  }
}

// The breakdown behind the header cost chip. Admin-only, like the chip itself.
app.get('/api/sessions/:id/usage', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const session = await db.fullSession(id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const calls = await db.listLlmCalls(id);
    res.json({
      ...usage.summarise({ calls, messages: session.messages, reports: session.reports, autopilotRuns: session.autopilot_runs }),
      categories: usage.CATEGORIES,
      usd_to_gbp: config.USD_TO_GBP,
    });
  } catch (e) { next(e); }
});
// A non-numeric id would reach Postgres as an invalid bigint and come back as a 500.
const questionFor = (qid, sessionId) => (/^\d+$/.test(String(qid)) ? db.getQuestion(String(qid), sessionId) : Promise.resolve(null));

// Stores the "Questions for <X>:" items of one agent message. Returns how many
// were new. Only panel agents ask; the moderator assistant's output is not scanned.
async function extractQuestions(sessionId, messageId, speaker, mode, text) {
  if (!prompts.AGENT_ORDER.includes(speaker)) return 0;
  const items = questions.parseQuestions(text, panelAgents(), speaker);
  return db.addQuestions(sessionId, messageId, { asker: speaker, round: mode, items });
}

// Writes the minutes entry for one action on a question (see
// questions.questionMinutes). The action itself has already been saved, so a
// failure here is logged and never fails the request.
async function recordQuestionMinutes(sessionId, messages, fields) {
  try {
    const entry = questions.questionMinutes({ ...fields, messages, label: agentLabel });
    await db.addMeetingMinutes(sessionId, { round: questions.MINUTES_ROUND, ...entry });
  } catch (e) {
    console.error(`[questions] minutes entry for question ${fields.question && fields.question.id} failed:`, e.message);
  }
}

app.patch('/api/sessions/:id/questions/:qid', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const qRow = await questionFor(req.params.qid, id);
    if (!qRow) return res.status(404).json({ error: 'Question not found' });
    // discussion: the discuss-to-resolution run this change closes. A run that
    // decided nothing (stopped or failed) sends it with no status, and then only
    // its minutes entry is written: the question keeps whatever status the
    // server holds, which may have changed while the run was going.
    const d = req.body.discussion && typeof req.body.discussion === 'object' ? req.body.discussion : null;
    const discussion = d && /^\d+$/.test(String(d.run_id))
      ? { run_id: String(d.run_id), outcome: String(d.outcome || '').slice(0, 40), cycles: Math.max(0, Math.min(100, Number(d.cycles) || 0)) }
      : null;
    // Read before the update: nothing promises qRow is not the object the update changes.
    const from = qRow.status;
    const statusGiven = req.body.status != null && req.body.status !== '';
    if (!statusGiven && !discussion) return res.status(400).json({ error: 'Unknown status ' });
    const status = statusGiven ? String(req.body.status) : from;
    if (!questions.STATUSES.includes(status)) return res.status(400).json({ error: `Unknown status ${status}` });
    const note = req.body.resolution_note === undefined ? qRow.resolution_note : String(req.body.resolution_note || '').slice(0, 500) || null;
    // Reopening clears the record of what answered it; any other change keeps it
    // unless a new answer message is given.
    const answer = !statusGiven ? qRow.answer_message_id : status === 'open' ? null
      : (req.body.answer_message_id != null && /^\d+$/.test(String(req.body.answer_message_id)) ? String(req.body.answer_message_id) : qRow.answer_message_id);
    const resolutionNote = !statusGiven ? qRow.resolution_note : status === 'open' ? null : note;
    if (statusGiven) await db.updateQuestion(qRow.id, id, { status, resolution_note: resolutionNote, answer_message_id: answer });
    if (discussion || status !== from) {
      const messages = await db.listMessages(id);
      const answerMessage = answer ? messages.find((m) => String(m.id) === String(answer)) : null;
      await recordQuestionMinutes(id, messages, {
        question: qRow, action: discussion ? 'discussion' : 'status', from, to: status,
        // With no status change the row's old note is not something this did.
        note: statusGiven ? resolutionNote : null, discussion,
        // Only an answer this change names: a status click keeps an older answer
        // on the row, and the entry should not claim it happened now.
        answerMessage: req.body.answer_message_id != null ? answerMessage : null,
      });
    }
    res.json({ questions: await db.listQuestions(id), meeting_minutes: await db.listMeetingMinutes(id) });
  } catch (e) { next(e); }
});

// The moderator answers a question by hand. The answer goes into the transcript
// as a moderator message addressed to the asker (so it reaches every later turn
// like any other reply), and the question is marked answered by it. The client
// then asks the asker to respond, as it does for any addressed reply.
app.post('/api/sessions/:id/questions/:qid/answer', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const qRow = await questionFor(req.params.qid, id);
    if (!qRow) return res.status(404).json({ error: 'Question not found' });
    const answer = String(req.body.text || '').trim().slice(0, 8000);
    if (!answer) return res.status(400).json({ error: 'Empty answer' });
    const to = prompts.AGENT_ORDER.includes(qRow.asker) ? qRow.asker : 'all';
    const quoted = qRow.text.replace(/\s+/g, ' ');
    const msg = await db.addMessage(id, {
      role: 'user', speaker: 'user', mode: 'reply', addressed_to: to,
      text: `**Answer to ${agentLabel(qRow.asker)}'s question:** "${quoted}"\n\n${answer}`,
    });
    const from = qRow.status;
    await db.updateQuestion(qRow.id, id, { status: 'answered', resolution_note: 'Answered by the moderator', answer_message_id: msg.id });
    await recordQuestionMinutes(id, [...(await db.listMessages(id)).filter((m) => String(m.id) !== String(msg.id)), msg], {
      question: qRow, action: 'answer', from, to: 'answered', answerMessage: msg,
    });
    res.json({
      message: msg, questions: await db.listQuestions(id), meeting_minutes: await db.listMeetingMinutes(id),
      respondents: to === 'all' ? [] : [to],
    });
  } catch (e) { next(e); }
});

// Backfill: finds the questions in every agent message already in the session,
// for evaluations that ran before this feature. Safe to repeat.
app.post('/api/sessions/:id/questions/scan', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const session = await db.fullSession(id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    let added = 0;
    for (const m of session.messages) {
      if (m.role !== 'agent' || m.error || !m.text) continue;
      added += await extractQuestions(id, m.id, m.speaker, m.mode, m.text);
    }
    res.json({ added, questions: await db.listQuestions(id) });
  } catch (e) { next(e); }
});

// The answered-check: the Moderator Assistant reads the transcript and says
// which open questions a later message has answered. Only 'open' questions are
// considered, so nothing the moderator decided by hand is overwritten.
app.post('/api/sessions/:id/questions/check', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const session = await db.fullSession(id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const open = (session.questions || []).filter((x) => x.status === 'open');
    if (!open.length) return res.json({ updated: 0, questions: session.questions || [], meeting_minutes: session.meeting_minutes || [] });
    const seqOf = new Map(session.messages.map((m) => [String(m.id), m.seq]));
    const list = open.map((x) => `- id ${x.id} · asked by ${agentLabel(x.asker)} in message [${seqOf.get(String(x.message_id)) ?? '?'}] to ${x.addressees.split(',').map(agentLabel).join(' and ')}: ${x.text.replace(/\s+/g, ' ')}`).join('\n');
    const checkModel = session.model || config.MODEL;
    const checkStarted = Date.now();
    const checkCall = { classification: usage.classify({ mode: 'questions_check' }), speaker: 'moderator', requestedModel: checkModel, started: checkStarted };
    let result;
    try {
      result = await runTurn({
        inputs: session.inputs, agentKey: 'moderator', mode: 'questions_check', instruction: list,
        messages: session.messages, model: checkModel, onEvent: () => {},
      });
    } catch (err) {
      await recordLlmCall(req, id, { ...checkCall, outcome: err, error: err.message });
      throw err;
    }
    await recordLlmCall(req, id, { ...checkCall, outcome: result });
    const openIds = new Set(open.map((x) => String(x.id)));
    const bySeq = new Map(session.messages.map((m) => [Number(m.seq), m]));
    const claims = questions.parseAnsweredCheck(result.text);
    // "Nothing answered" and "the model's reply could not be read" both end with
    // no updates, so the log line says which one it was and why claims were dropped.
    const skipped = { unknownId: 0, badSeq: 0, notAnAnswer: 0, noLongerOpen: 0 };
    let updated = 0;
    for (const a of claims) {
      if (!openIds.has(a.id)) { skipped.unknownId++; continue; }
      const qRow = open.find((x) => String(x.id) === a.id);
      const answerMsg = bySeq.get(a.seq);
      // An answer has to come after the question; anything else is the model
      // pointing at the question itself or at an earlier message.
      const askedSeq = seqOf.get(String(qRow.message_id));
      if (!answerMsg || (askedSeq != null && answerMsg.seq <= askedSeq)) { skipped.badSeq++; continue; }
      // It has to be a real answer from someone else: not the asker restating
      // the question, not a system note, not a failed or unfinished turn.
      if (!answerMsg.text || answerMsg.error || answerMsg.role === 'system' || answerMsg.speaker === qRow.asker) { skipped.notAnAnswer++; continue; }
      const row = await db.updateQuestion(qRow.id, id, {
        status: 'answered', resolution_note: a.note || `Answered in #${answerMsg.seq}`, answer_message_id: answerMsg.id,
      }, { onlyIfOpen: true });
      if (row) {
        updated++;
        await recordQuestionMinutes(id, session.messages, {
          question: qRow, action: 'check', from: 'open', to: 'answered', note: row.resolution_note, answerMessage: answerMsg,
        });
      } else skipped.noLongerOpen++;
    }
    const raw = String(result.text || '');
    // listed counts the reply's entries before malformed ones (non-numeric ids)
    // are dropped; the reply's opening is logged whenever something was lost.
    const listed = questions.answeredListLength(raw);
    const readable = listed >= 0;
    console.log(`[questions/check] session ${id} model=${result.model || '?'} open=${open.length} reply_chars=${raw.length} readable=${readable} listed=${listed} claims=${claims.length} updated=${updated} skipped=${JSON.stringify(skipped)} cost_usd=${Number(result.cost_usd || 0).toFixed(4)}`
      + (readable && listed === claims.length ? '' : ` reply_start=${JSON.stringify(raw.slice(0, 200))}`));
    res.json({
      updated, questions: await db.listQuestions(id),
      meeting_minutes: updated ? await db.listMeetingMinutes(id) : session.meeting_minutes || [],
    });
  } catch (e) { next(e); }
});

// assembleText lives in src/transcript.js — see the note there on why.
// Autopilot's "Hard limit: N characters" is only a prompt instruction — small/
// free models routinely ignore it (observed: a 300-char cap produced a 2,000+
// char reply). Back it with a real truncation so the limit holds regardless of
// model compliance, while preserving the trailing POSITION line the unanimity
// check depends on. 10% slack matches what the plan's own verification allows.
function enforceCharLimit(text, maxChars) {
  if (!maxChars || maxChars === 'as_required') return text;
  const limit = Math.round(Number(maxChars) * 1.1);
  if (text.length <= limit) return text;
  // The trailing verdict line survives truncation: POSITION for a discussion,
  // QUESTION STATUS for a question discussion (the asker's turn).
  const posMatch = /\n*(?:POSITION:\s*(?:AGREE|DISAGREE)|QUESTION STATUS:\s*(?:RESOLVED|OPEN))\s*[—-]\s*.*$/i.exec(text);
  const positionLine = posMatch ? posMatch[0].trim() : '';
  const body = posMatch ? text.slice(0, posMatch.index) : text;
  const bodyLimit = Math.max(0, limit - positionLine.length - 40);
  let cut = body.slice(0, bodyLimit);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > bodyLimit * 0.6) cut = cut.slice(0, lastSpace);
  const note = `[…truncated to the ${maxChars}-character limit]`;
  return positionLine ? `${cut.trimEnd()} ${note}\n\n${positionLine}` : `${cut.trimEnd()} ${note}`;
}

const VALID_TURN_MODES = new Set(['opening', 'round2', 'round3', 'crosstalk', 'reply', 'custom', 'dive_deeper', 'meeting_minutes', 'decision', 'autopilot', 'report']);

// The standard meetings build on each other (Round 2 challenges Round 1's
// baselines, Round 3 converges on what Round 2 raised) — running one before
// its prerequisite has an answer from every agent produces nonsense (e.g.
// "attack two assumptions from the others" with nothing yet said).
const ROUND_SEQUENCE = ['opening', 'round2', 'round3', 'crosstalk'];
// Completed = finished without error. An unfinished row (text NULL, error
// NULL) is a turn still running or orphaned by a dropped connection, not an
// answer the next meeting can build on.
function agentsWithCompletedRound(messages, mode) {
  return new Set(messages.filter((m) => m.mode === mode && m.role === 'agent' && !m.error && m.text != null).map((m) => m.speaker));
}

app.post('/api/sessions/:id/turn', async (req, res) => {
  const id = Number(req.params.id);
  const session = await db.fullSession(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const speaker = req.body.speaker;
  const mode = req.body.mode || 'crosstalk';
  // Unbounded free text goes straight into the prompt sent to a paid-capable
  // model — cap it well above any legitimate custom instruction's length.
  const instruction = String(req.body.instruction || '').slice(0, 4000);
  if (!prompts.AGENTS[speaker]) return res.status(400).json({ error: `Unknown speaker ${speaker}` });
  // `mode` is stored on the message row and rendered back into the DOM
  // (public/app.js) — an unwhitelisted value would be a stored-XSS vector.
  if (!VALID_TURN_MODES.has(mode)) return res.status(400).json({ error: `Unknown mode ${mode}` });
  if (speaker === 'moderator' && !['decision', 'report'].includes(mode)) return res.status(400).json({ error: 'The moderator assistant only writes the decision output or a report' });
  if (mode === 'report' && speaker !== 'moderator') return res.status(400).json({ error: 'Only the moderator assistant writes reports' });
  const seqIdx = ROUND_SEQUENCE.indexOf(mode);
  if (seqIdx > 0) {
    for (let i = 0; i < seqIdx; i++) {
      const done = agentsWithCompletedRound(session.messages, ROUND_SEQUENCE[i]);
      if (prompts.AGENT_ORDER.some((a) => !done.has(a))) {
        return res.status(400).json({ error: `Run ${ROUND_SEQUENCE[i]} for all ${prompts.AGENT_ORDER.length} agents before starting ${mode}.` });
      }
    }
  }

  // Reports don't join the transcript: no message row / turn-lock up front.
  // Final reports still get a message at the end (see below) for backward
  // compatibility. Every other mode uses beginAgentTurn's DB-backed lock — the
  // row itself is the durable, cross-instance lock; an in-process Set doesn't
  // see a sibling turn running in another Vercel lambda instance, so it can't
  // actually stop a double-fire in production.
  const isReport = mode === 'report';
  let msg = null;
  if (!isReport) {
    try {
      msg = await db.beginAgentTurn(id, { role: speaker === 'moderator' ? 'moderator' : 'agent', speaker, mode });
    } catch (err) {
      // ALREADY_RUNNING is this app's own message and safe to show; anything
      // else here is a database error whose text belongs only in the log.
      if (err.code === 'ALREADY_RUNNING') return res.status(409).json({ error: err.message });
      const ref = errorRef();
      console.error(`[turn ${ref}] beginAgentTurn failed for session ${id}:`, err);
      return res.status(500).json({ error: `Could not start this turn (reference ${ref}).`, ref });
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  // Autopilot: resolve the stance sentence server-side from its slider index
  // (fill() substitutes {{COUNTRY}} etc — the level-5 bank entry names it),
  // and the disagreement topic (if scoped) so the model gets a plain sentence.
  let stanceText = null;
  let disagreementTopic = null;
  let questionScope = null;
  if (mode === 'autopilot') {
    if (req.body.stance_index) {
      const entry = prompts.STANCE[String(req.body.stance_index)];
      stanceText = entry ? prompts.fill(entry.text, session.inputs) : null;
    }
    if (req.body.disagreement_n) {
      const d = session.disagreements.find((x) => x.n === Number(req.body.disagreement_n));
      disagreementTopic = d ? d.topic : null;
    }
    if (req.body.question_id != null) {
      const qRow = (session.questions || []).find((x) => String(x.id) === String(req.body.question_id));
      if (qRow) {
        const addressees = qRow.addressees.split(',').filter(Boolean);
        questionScope = {
          text: qRow.text,
          askerLabel: agentLabel(qRow.asker),
          addresseesLabel: addressees.map(agentLabel).join(' and '),
          role: speaker === qRow.asker ? 'asker' : 'addressee',
        };
      }
    }
  }

  if (!isReport) send('start', { message_id: msg.id, seq: msg.seq, speaker, mode, created_at: msg.created_at });
  else send('start', { report: true, kind: req.body.kind, depth: req.body.depth });
  const searches = [];
  const turnStarted = Date.now();
  // disagreement_n on a custom meeting is classification only: it marks the
  // "Discuss" action on a disagreement, and changes nothing in the prompt.
  const turnCall = {
    classification: usage.classify({
      mode, question_id: req.body.question_id, disagreement_n: req.body.disagreement_n,
      report_kind: req.body.kind === 'final' ? 'final' : 'interim',
    }),
    speaker, requestedModel: session.model || config.MODEL, started: turnStarted,
  };
  // runTurn's result once it has one: a failure after that point (saving the
  // answer, say) still spent the whole turn, so the catch records that figure.
  let result = null;
  let callRecorded = false;
  const recordTurn = (fields) => { callRecorded = true; return recordLlmCall(req, id, { ...turnCall, ...fields }); };
  try {
    result = await runTurn({
      inputs: session.inputs, agentKey: speaker, mode, instruction, messages: session.messages,
      disagreements: session.disagreements,
      model: session.model || config.MODEL,
      max_chars: req.body.max_chars, stance: questionScope ? null : stanceText, disagreementTopic, question: questionScope,
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
      // Recorded against the report, not the Final report's transcript copy:
      // summarise() skips a message whose report_id is already accounted for.
      await recordTurn({ outcome: result, report_id: report.id });
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
      return res.end();
    }

    // The row can be gone by now: Resume in the app clears a turn it believes
    // is stuck. Saving sources or disagreements against a deleted message would
    // leave them pointing at nothing, so discard this result instead.
    if (!(await db.getMessage(msg.id))) {
      console.warn(`[turn ${msg.id}] ${speaker}/${mode} finished after its row was cleared; result discarded`);
      await recordTurn({ outcome: result, message_id: msg.id, error: 'Cleared before it finished; answer discarded' });
      send('error', { message_id: msg.id, message: 'This turn was cleared before it finished, so its answer was discarded.', code: 'CLEARED' });
      return;
    }
    let text = await assembleText(id, msg.id, speaker, result.text, result.trace);
    if (mode === 'autopilot') text = enforceCharLimit(text, req.body.max_chars);
    const u = result.usage;
    await db.updateMessage(msg.id, {
      text, content_json: JSON.stringify({
        model: result.model, trace: result.trace, usage: u, stop_reason: result.stop_reason,
        ...(mode === 'autopilot' ? { max_chars: req.body.max_chars, stance_index: req.body.stance_index, autopilot: req.body.autopilot } : {}),
      }),
      input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_tokens: 0, cache_write_tokens: 0,
      searches: u.searches, cost_usd: result.cost_usd, error: null, duration_ms: Date.now() - turnStarted,
    });
    await recordTurn({ outcome: result, message_id: msg.id });
    const disagreements = await extractDisagreements(id, msg.id, text);
    // A question that cannot be stored must not fail a turn that already has
    // its answer saved: log it and carry on.
    const newQuestions = await extractQuestions(id, msg.id, speaker, mode, text)
      .catch((e) => { console.error(`[turn ${msg.id}] question extraction failed:`, e.message); return 0; });
    if (mode === 'decision') await db.setDecision(id, text);
    await db.touchSession(id);
    const [message, sources, allDisagreements, allQuestions] = await Promise.all([
      db.getMessage(msg.id), db.listSources(id), db.listDisagreements(id), db.listQuestions(id),
    ]);
    send('done', {
      message,
      sources: sources.map((s) => ({ ...s, cited_by: JSON.parse(s.cited_by_json) })),
      disagreements: allDisagreements,
      new_disagreements: disagreements,
      questions: allQuestions,
      new_questions: newQuestions,
      searches,
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`[turn ${msg ? msg.id : 'report'}] ${speaker}/${mode} failed:`, message);
    if (!callRecorded) await recordTurn({ outcome: result || err, message_id: msg ? msg.id : null, error: message });
    if (msg) {
      await db.updateMessage(msg.id, {
        text: '', content_json: null, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
        searches: 0, cost_usd: 0, error: message, duration_ms: Date.now() - turnStarted,
      }).catch((e) => console.error(`[turn ${msg.id}] failed to record error:`, e.message));
    }
    send('error', { message_id: msg ? msg.id : null, message, code: err.code || (err.status ? `HTTP ${err.status}` : 'ERROR') });
  } finally {
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

// ---------- meeting minutes ----------
// Runs the moderator agent (non-streaming — minutes are short) and stores the
// result separately from `messages`, so it never touches the transcript/filter
// chips; email is fire-and-forget and never blocks the response.
app.post('/api/sessions/:id/meeting-minutes', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const session = await db.fullSession(id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const round = String(req.body.round || '').slice(0, 200);
    const label = String(req.body.label || round).slice(0, 200);
    // The browser sends the id as node-pg gave it: messages.id is bigserial, so a string ("123").
    const rawAnchor = req.body.anchor_message_id;
    const anchorNum = typeof rawAnchor === 'string' && /^\d+$/.test(rawAnchor) ? Number(rawAnchor) : rawAnchor;
    const anchorMessageId = Number.isSafeInteger(anchorNum) ? anchorNum : null;
    const minutesModel = session.model || config.MODEL;
    const minutesCall = { classification: usage.classify({ mode: 'meeting_minutes' }), speaker: 'moderator', requestedModel: minutesModel, started: Date.now() };
    let result;
    try {
      result = await runTurn({
        inputs: session.inputs, agentKey: 'moderator', mode: 'meeting_minutes', instruction: label,
        messages: session.messages, model: minutesModel, onEvent: () => {},
      });
    } catch (err) {
      await recordLlmCall(req, id, { ...minutesCall, outcome: err, error: err.message });
      throw err;
    }
    await recordLlmCall(req, id, { ...minutesCall, outcome: result });
    const row = await db.addMeetingMinutes(id, { round, label, text: result.text, anchor_message_id: anchorMessageId });
    const recipient = (req.user && req.user.email) || process.env.MODERATOR_EMAIL || null;
    sendMeetingMinutesEmail(session, row, recipient).catch((e) => console.error('[meeting-minutes] email failed:', e.message));
    res.json(row);
  } catch (e) { next(e); }
});

// In-app equivalent of the emailed approve link, for whoever is at the keyboard.
app.patch('/api/meeting-minutes/:id/approve', async (req, res, next) => {
  try {
    const row = await db.setMinutesApproved(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Meeting minutes not found' });
    res.json(row);
  } catch (e) { next(e); }
});

app.get('/api/meeting-minutes/:token/approve', async (req, res, next) => {
  try {
    const row = await db.getMinutesByToken(req.params.token);
    if (!row) return res.status(404).send('Meeting minutes not found');
    await db.setMinutesApproved(row.id);
    res.redirect(`/?session=${row.session_id}&approved=${encodeURIComponent(row.round)}`);
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

// One Intelligence tab, as Word or PDF. The tab key is checked against
// src/intel-export.js's list before anything is loaded; ?cut= only matters to
// Agent notes, which exports whichever of its four views is on screen.
const EXPORT_TYPES = {
  docx: { build: exporter.toDocx, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pdf: { build: exporter.toPdf, type: 'application/pdf' },
};
app.get('/api/sessions/:id/intel/:section/export.:format', async (req, res, next) => {
  try {
    const fmt = Object.hasOwn(EXPORT_TYPES, req.params.format) ? EXPORT_TYPES[req.params.format] : null;
    if (!fmt || !Object.hasOwn(intelExport.SECTIONS, req.params.section)) return res.status(404).send('Export not found');
    const s = await db.fullSession(Number(req.params.id));
    if (!s) return res.status(404).send('Session not found');
    const cut = ['agent', 'meeting', 'disagreement', 'resolution'].includes(req.query.cut) ? req.query.cut : 'agent';
    const section = intelExport.sectionDoc(s, req.params.section, { cut });
    const buf = await fmt.build(s, { section });
    res.setHeader('Content-Type', fmt.type);
    res.setHeader('Content-Disposition', `attachment; filename="${exporter.sectionFileName(s, req.params.section)}.${req.params.format}"`);
    res.send(buf);
  } catch (e) { next(e); }
});

// Every deliberate failure in this file answers with its own res.status(4xx),
// so anything reaching here is unexpected — a driver error, a bad query, a
// null dereference. Those messages are written for the log, not for a user:
// pg in particular reports table names, column names and constraint names, and
// a connection failure can carry the host out of DATABASE_URL. Log the whole
// error, hand back a reference the log can be searched by.
function errorRef() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const ref = errorRef();
  console.error(`[error ${ref}] ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: `Something went wrong on the server (reference ${ref}). The detail is in the server log.`, ref });
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
