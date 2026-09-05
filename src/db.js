'use strict';
const crypto = require('crypto');
const { Pool } = require('pg');
const config = require('./config');
// Grace beyond the in-turn budget before an unfinished row is declared dead.
const STALE_TURN_MS = config.TURN_TIMEOUT_MS + 120000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
});

async function q(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}
async function one(text, params) {
  const rows = await q(text, params);
  return rows[0] || null;
}

async function listSessions() {
  return q(`SELECT s.id, s.title, s.product, s.country, s.created_at, s.updated_at,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
      (SELECT COALESCE(SUM(cost_usd),0) FROM messages m WHERE m.session_id = s.id) AS cost_usd,
      (s.decision_text IS NOT NULL) AS has_decision
     FROM sessions s ORDER BY s.updated_at DESC`);
}

async function getSession(id) { return one('SELECT * FROM sessions WHERE id = $1', [id]); }
async function lastSession() { return one('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1', []); }
async function renameSession(id, title) { await q('UPDATE sessions SET title = $1, updated_at = now() WHERE id = $2', [title, id]); }
async function touchSession(id) { await q('UPDATE sessions SET updated_at = now() WHERE id = $1', [id]); }
async function setDecision(id, text) { await q('UPDATE sessions SET decision_text = $1, updated_at = now() WHERE id = $2', [text, id]); }
async function setModel(id, model) { await q('UPDATE sessions SET model = $1, updated_at = now() WHERE id = $2', [model, id]); }
async function updateInputs(id, inputs) {
  await q(
    'UPDATE sessions SET inputs_json = $1, product = $2, country = $3, updated_at = now() WHERE id = $4',
    [JSON.stringify(inputs), inputs.product || null, inputs.country || null, id],
  );
}
async function deleteSession(id) { await q('DELETE FROM sessions WHERE id = $1', [id]); }

async function createSession(inputs, model, ownerId) {
  const productShort = (inputs.product || 'Untitled product').split(/\s[—–-]\s/)[0].trim();
  const title = `${productShort} · ${inputs.country || 'country?'}`;
  const row = await one(
    'INSERT INTO sessions (title, product, country, inputs_json, model, owner_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [title, inputs.product || null, inputs.country || null, JSON.stringify(inputs), model || null, ownerId || null],
  );
  return row;
}

async function listMessages(sessionId) { return q('SELECT * FROM messages WHERE session_id = $1 ORDER BY seq', [sessionId]); }
async function getMessage(id) { return one('SELECT * FROM messages WHERE id = $1', [id]); }
async function deleteMessage(id, sessionId) { await q('DELETE FROM messages WHERE id = $1 AND session_id = $2', [id, sessionId]); }
async function setFavourite(id, sessionId, favourite) {
  return one('UPDATE messages SET favourite = $1 WHERE id = $2 AND session_id = $3 RETURNING *', [favourite, id, sessionId]);
}

async function updateMessage(id, { text, content_json, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, searches, cost_usd, error, duration_ms }) {
  await q(
    `UPDATE messages SET text = $1, content_json = $2, input_tokens = $3, output_tokens = $4,
     cache_read_tokens = $5, cache_write_tokens = $6, searches = $7, cost_usd = $8, error = $9, duration_ms = $10 WHERE id = $11`,
    [text, content_json, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, searches, cost_usd, error, duration_ms ?? null, id],
  );
}

async function addMessage(sessionId, fields) {
  const row = await withSessionLock(sessionId, async (client) => {
    const seqRow = (await client.query('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages WHERE session_id = $1', [sessionId])).rows[0];
    const seq = seqRow.seq;
    return (await client.query(
      `INSERT INTO messages (session_id, seq, role, speaker, mode, addressed_to, text, content_json,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, searches, cost_usd, error)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [sessionId, seq, fields.role, fields.speaker, fields.mode || null, fields.addressed_to || null,
        fields.text || null, fields.content_json || null,
        fields.input_tokens || 0, fields.output_tokens || 0, fields.cache_read_tokens || 0, fields.cache_write_tokens || 0,
        fields.searches || 0, fields.cost_usd || 0, fields.error || null],
    )).rows[0];
  });
  await touchSession(sessionId);
  return row;
}

// Same insert as addMessage, but the "is this agent already running" check
// lives in the DB (an unfinished row: text IS NULL AND error IS NULL) instead
// of an in-process Set — a Set is per-lambda-instance and does not see turns
// running in a sibling instance on Vercel, so it can't actually prevent a
// double-fire in production. Only used for agent/moderator turns; the human
// reply endpoint has no such race and keeps using plain addMessage.
async function beginAgentTurn(sessionId, { role, speaker, mode }) {
  const row = await withSessionLock(sessionId, async (client) => {
    // A row left unfinished past the turn time budget means the lambda was
    // killed before it could record the error — mark it failed so it stops
    // acting as a permanent lock (and shows up as retryable in the UI).
    await client.query(
      `UPDATE messages SET error = $3, text = ''
       WHERE session_id = $1 AND speaker = $2 AND text IS NULL AND error IS NULL
         AND created_at < now() - ($4 || ' milliseconds')::interval`,
      [sessionId, speaker, 'Turn did not finish (server timed out or was interrupted). Retry.', String(STALE_TURN_MS)],
    );
    const existing = (await client.query(
      'SELECT id FROM messages WHERE session_id = $1 AND speaker = $2 AND text IS NULL AND error IS NULL',
      [sessionId, speaker],
    )).rows[0];
    if (existing) {
      const e = new Error('This agent already has a turn running for this session');
      e.code = 'ALREADY_RUNNING';
      throw e;
    }
    const seqRow = (await client.query('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages WHERE session_id = $1', [sessionId])).rows[0];
    const seq = seqRow.seq;
    return (await client.query(
      'INSERT INTO messages (session_id, seq, role, speaker, mode) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [sessionId, seq, role, speaker, mode || null],
    )).rows[0];
  });
  await touchSession(sessionId);
  return row;
}

async function listSources(sessionId) { return q('SELECT * FROM sources WHERE session_id = $1 ORDER BY n', [sessionId]); }

// Serializes read-then-write "next n" numbering (sources, disagreements) per
// session, even across concurrent turns (parallel Round 1) — an advisory
// transaction lock on the session id, held on one dedicated connection for
// the duration of fn, auto-released at COMMIT/ROLLBACK.
async function withSessionLock(sessionId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [sessionId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function upsertSource(sessionId, { url, title, kind, messageId, speaker }) {
  return withSessionLock(sessionId, async (client) => {
    const existing = (await client.query('SELECT * FROM sources WHERE session_id = $1 AND url = $2', [sessionId, url])).rows[0];
    if (existing) {
      const citedBy = JSON.parse(existing.cited_by_json);
      if (!citedBy.some((c) => c.message_id === messageId)) citedBy.push({ message_id: messageId, speaker });
      const newKind = existing.kind === 'cited' || kind === 'cited' ? 'cited' : 'searched';
      await client.query('UPDATE sources SET title = COALESCE($1, title), kind = $2, cited_by_json = $3 WHERE id = $4',
        [title || null, newKind, JSON.stringify(citedBy), existing.id]);
      return existing.n;
    }
    const n = (await client.query('SELECT COALESCE(MAX(n),0)+1 AS n FROM sources WHERE session_id = $1', [sessionId])).rows[0].n;
    await client.query('INSERT INTO sources (session_id, n, url, title, kind, first_message_id, cited_by_json) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [sessionId, n, url, title || null, kind, messageId, JSON.stringify([{ message_id: messageId, speaker }])]);
    return n;
  });
}

// ---------- meeting minutes ----------
async function listMeetingMinutes(sessionId) { return q('SELECT * FROM meeting_minutes WHERE session_id = $1 ORDER BY id', [sessionId]); }
async function addMeetingMinutes(sessionId, { round, label, text, anchor_message_id }) {
  const approve_token = crypto.randomBytes(16).toString('hex');
  return one(
    `INSERT INTO meeting_minutes (session_id, round, label, text, anchor_message_id, approve_token)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [sessionId, round, label, text, anchor_message_id || null, approve_token],
  );
}
async function setMinutesApproved(id) { return one('UPDATE meeting_minutes SET approved = true WHERE id = $1 RETURNING *', [id]); }
async function getMinutesByToken(token) { return one('SELECT * FROM meeting_minutes WHERE approve_token = $1', [token]); }

async function listDisagreements(sessionId) { return q('SELECT * FROM disagreements WHERE session_id = $1 ORDER BY n', [sessionId]); }
async function setDisStatus(sessionId, n, status) { await q('UPDATE disagreements SET status = $1 WHERE session_id = $2 AND n = $3', [status, sessionId, n]); }

function normTopic(topic) {
  return String(topic || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// A restated disagreement (later round revisits the same topic, or one side
// marks it RESOLVED) updates the existing row instead of appending a second
// one — otherwise the log fills with duplicates and a resolution never
// retires the original UNRESOLVED entry. Topic-less ("untitled") blocks skip
// dedup since they'd otherwise all collapse onto one row.
async function upsertDisagreement(sessionId, messageId, topic, body, status) {
  return withSessionLock(sessionId, async (client) => {
    const norm = normTopic(topic);
    let existing = null;
    if (norm && norm !== 'untitled') {
      const rows = (await client.query('SELECT id, n, topic FROM disagreements WHERE session_id = $1', [sessionId])).rows;
      existing = rows.find((r) => normTopic(r.topic) === norm);
    }
    if (existing) {
      await client.query('UPDATE disagreements SET message_id = $1, topic = $2, body = $3, status = $4 WHERE id = $5',
        [messageId, topic, body, status, existing.id]);
      return existing.n;
    }
    const n = (await client.query('SELECT COALESCE(MAX(n),0)+1 AS n FROM disagreements WHERE session_id = $1', [sessionId])).rows[0].n;
    await client.query('INSERT INTO disagreements (session_id, message_id, n, topic, body, status) VALUES ($1,$2,$3,$4,$5,$6)',
      [sessionId, messageId, n, topic, body, status]);
    return n;
  });
}

async function fullSession(id) {
  const session = await getSession(id);
  if (!session) return null;
  const [messages, sources, disagreements, meeting_minutes] = await Promise.all([
    listMessages(id), listSources(id), listDisagreements(id), listMeetingMinutes(id),
  ]);
  return {
    ...session,
    inputs: JSON.parse(session.inputs_json),
    messages,
    sources: sources.map((s) => ({ ...s, cited_by: JSON.parse(s.cited_by_json) })),
    disagreements,
    meeting_minutes,
  };
}

async function getDefaults() {
  const row = await one('SELECT values_json FROM app_defaults WHERE id = true', []);
  return row ? JSON.parse(row.values_json) : {};
}
async function setDefaultField(key, value) {
  const current = await getDefaults();
  current[key] = value;
  const json = JSON.stringify(current);
  await q(
    `INSERT INTO app_defaults (id, values_json, updated_at) VALUES (true, $1, now())
     ON CONFLICT (id) DO UPDATE SET values_json = $1, updated_at = now()`,
    [json],
  );
  return current;
}

// ---------- users (auth) ----------
async function countUsers() { return Number((await one('SELECT COUNT(*)::int AS n FROM users', [])).n); }
async function getUserByEmail(email) { return one('SELECT * FROM users WHERE lower(email) = lower($1)', [email]); }
async function listUsers() { return q('SELECT id, email, is_admin, created_at FROM users ORDER BY created_at', []); }
async function createUser({ email, password_hash, is_admin }) {
  return one('INSERT INTO users (email, password_hash, is_admin) VALUES ($1,$2,$3) RETURNING id, email, is_admin, created_at',
    [email.toLowerCase(), password_hash, Boolean(is_admin)]);
}
async function countAdmins() { return Number((await one('SELECT COUNT(*)::int AS n FROM users WHERE is_admin', [])).n); }
async function updateUser(id, { password_hash, is_admin }) {
  const sets = []; const vals = []; let i = 1;
  if (password_hash !== undefined) { sets.push(`password_hash = $${i++}`); vals.push(password_hash); }
  if (is_admin !== undefined) { sets.push(`is_admin = $${i++}`); vals.push(Boolean(is_admin)); }
  if (!sets.length) return getUserById(id);
  vals.push(id);
  return one(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, email, is_admin, created_at`, vals);
}
async function getUserById(id) { return one('SELECT id, email, is_admin, created_at FROM users WHERE id = $1', [id]); }
async function deleteUser(id) { await q('DELETE FROM users WHERE id = $1', [id]); }

// ---------- agents (editable profiles) ----------
async function listAgents() { return q('SELECT * FROM agents ORDER BY key', []); }
async function getAgent(key) { return one('SELECT * FROM agents WHERE key = $1', [key]); }
async function updateAgent(key, { knowledge, can_web_search, can_open_url, stance_default }) {
  // description/role columns still exist (legacy) but are no longer read by
  // the prompt builder — persona text now comes from prompts/agents/<key>/,
  // see src/prompts.js personaFor(). This overlay is knowledge/abilities/stance only.
  const sets = []; const vals = []; let i = 1;
  const set = (col, val) => { sets.push(`${col} = $${i++}`); vals.push(val); };
  if (knowledge !== undefined) set('knowledge', knowledge);
  if (can_web_search !== undefined) set('can_web_search', Boolean(can_web_search));
  if (can_open_url !== undefined) set('can_open_url', Boolean(can_open_url));
  if (stance_default !== undefined) set('stance_default', Math.min(5, Math.max(1, Number(stance_default) || 3)));
  if (!sets.length) return getAgent(key);
  sets.push('updated_at = now()');
  vals.push(key);
  return one(`UPDATE agents SET ${sets.join(', ')} WHERE key = $${i} RETURNING *`, vals);
}

// ---------- knowledgebase (curated reference documents) ----------
async function listKnowledgeItems() { return q('SELECT * FROM knowledge_items ORDER BY category, id', []); }
async function createKnowledgeItem({ category, title, url, note, sensitive }) {
  return one(
    'INSERT INTO knowledge_items (category, title, url, note, sensitive) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [category, title, url, note || '', Boolean(sensitive)],
  );
}
async function updateKnowledgeItem(id, { category, title, url, note, sensitive }) {
  const sets = []; const vals = []; let i = 1;
  const set = (col, val) => { sets.push(`${col} = $${i++}`); vals.push(val); };
  if (category !== undefined) set('category', category);
  if (title !== undefined) set('title', title);
  if (url !== undefined) set('url', url);
  if (note !== undefined) set('note', note);
  if (sensitive !== undefined) set('sensitive', Boolean(sensitive));
  if (!sets.length) return one('SELECT * FROM knowledge_items WHERE id = $1', [id]);
  sets.push('updated_at = now()');
  vals.push(id);
  return one(`UPDATE knowledge_items SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
}
async function deleteKnowledgeItem(id) { await q('DELETE FROM knowledge_items WHERE id = $1', [id]); }

module.exports = {
  pool,
  getDefaults, setDefaultField,
  listSessions, getSession, lastSession, renameSession, touchSession, setDecision, setModel, updateInputs, deleteSession, createSession,
  listMessages, getMessage, deleteMessage, updateMessage, addMessage, beginAgentTurn, setFavourite,
  listSources, upsertSource,
  listDisagreements, setDisStatus, upsertDisagreement,
  listMeetingMinutes, addMeetingMinutes, setMinutesApproved, getMinutesByToken,
  fullSession,
  countUsers, getUserByEmail, listUsers, createUser, countAdmins, updateUser, getUserById, deleteUser,
  listAgents, getAgent, updateAgent,
  listKnowledgeItems, createKnowledgeItem, updateKnowledgeItem, deleteKnowledgeItem,
};
