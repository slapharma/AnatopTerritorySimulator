'use strict';
const { Pool } = require('pg');

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

async function createSession(inputs, model) {
  const productShort = (inputs.product || 'Untitled product').split(/\s[—–-]\s/)[0].trim();
  const title = `${productShort} · ${inputs.country || 'country?'}`;
  const row = await one(
    'INSERT INTO sessions (title, product, country, inputs_json, model) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [title, inputs.product || null, inputs.country || null, JSON.stringify(inputs), model || null],
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
  const seqRow = await one('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages WHERE session_id = $1', [sessionId]);
  const seq = seqRow.seq;
  const row = await one(
    `INSERT INTO messages (session_id, seq, role, speaker, mode, addressed_to, text, content_json,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, searches, cost_usd, error)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [sessionId, seq, fields.role, fields.speaker, fields.mode || null, fields.addressed_to || null,
      fields.text || null, fields.content_json || null,
      fields.input_tokens || 0, fields.output_tokens || 0, fields.cache_read_tokens || 0, fields.cache_write_tokens || 0,
      fields.searches || 0, fields.cost_usd || 0, fields.error || null],
  );
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

async function listDisagreements(sessionId) { return q('SELECT * FROM disagreements WHERE session_id = $1 ORDER BY n', [sessionId]); }
async function setDisStatus(sessionId, n, status) { await q('UPDATE disagreements SET status = $1 WHERE session_id = $2 AND n = $3', [status, sessionId, n]); }

async function addDisagreement(sessionId, messageId, topic, body, status) {
  return withSessionLock(sessionId, async (client) => {
    const n = (await client.query('SELECT COALESCE(MAX(n),0)+1 AS n FROM disagreements WHERE session_id = $1', [sessionId])).rows[0].n;
    await client.query('INSERT INTO disagreements (session_id, message_id, n, topic, body, status) VALUES ($1,$2,$3,$4,$5,$6)',
      [sessionId, messageId, n, topic, body, status]);
    return n;
  });
}

async function fullSession(id) {
  const session = await getSession(id);
  if (!session) return null;
  const [messages, sources, disagreements] = await Promise.all([
    listMessages(id), listSources(id), listDisagreements(id),
  ]);
  return {
    ...session,
    inputs: JSON.parse(session.inputs_json),
    messages,
    sources: sources.map((s) => ({ ...s, cited_by: JSON.parse(s.cited_by_json) })),
    disagreements,
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
async function updateAgent(key, { description, role, knowledge, can_web_search, can_open_url }) {
  const sets = []; const vals = []; let i = 1;
  const set = (col, val) => { sets.push(`${col} = $${i++}`); vals.push(val); };
  if (description !== undefined) set('description', description);
  if (role !== undefined) set('role', role);
  if (knowledge !== undefined) set('knowledge', knowledge);
  if (can_web_search !== undefined) set('can_web_search', Boolean(can_web_search));
  if (can_open_url !== undefined) set('can_open_url', Boolean(can_open_url));
  if (!sets.length) return getAgent(key);
  sets.push('updated_at = now()');
  vals.push(key);
  return one(`UPDATE agents SET ${sets.join(', ')} WHERE key = $${i} RETURNING *`, vals);
}

module.exports = {
  pool,
  getDefaults, setDefaultField,
  listSessions, getSession, lastSession, renameSession, touchSession, setDecision, setModel, updateInputs, deleteSession, createSession,
  listMessages, getMessage, deleteMessage, updateMessage, addMessage, setFavourite,
  listSources, upsertSource,
  listDisagreements, setDisStatus, addDisagreement,
  fullSession,
  countUsers, getUserByEmail, listUsers, createUser, countAdmins, updateUser, getUserById, deleteUser,
  listAgents, getAgent, updateAgent,
};
