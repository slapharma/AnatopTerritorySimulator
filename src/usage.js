'use strict';
// LLM usage and cost: what every model call was for, and the breakdown behind
// the session header's cost chip.
//
// Every model call in the app goes through agents.runTurn, and every caller of
// runTurn writes one llm_calls row (db.addLlmCall) — including calls whose
// result is stored nowhere else (the questions answered-check), stored without
// a cost (meeting minutes), or that failed after spending tokens. Before that
// ledger existed, cost lived only on messages and reports rows, so summarise()
// also folds in any of those that no ledger row accounts for. The chip and the
// modal therefore agree for old sessions as well as new ones.
//
// Pure: no database, no config. Tested in test/usage.test.js.

const CATEGORIES = [
  { key: 'agent_presentation', label: 'Agent presentations' },
  { key: 'question_resolution', label: 'Question resolution' },
  { key: 'disagreement_resolution', label: 'Disagreement resolution' },
  { key: 'autopilot', label: 'Autopilot discussion' },
  { key: 'reports', label: 'Reports and decision' },
  { key: 'meeting_minutes', label: 'Meeting minutes' },
  { key: 'other', label: 'Other' },
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

const FEATURE_LABEL = {
  opening: 'Baselines', round2: 'Challenge', round3: 'Converge', crosstalk: 'Cross-talk',
  reply: 'Reply', custom: 'Custom meeting', dive_deeper: 'Dive Deeper',
  question_discussion: 'Question discussion', questions_check: 'Answered check',
  disagreement_discussion: 'Disagreement discussion', disagreement_autopilot: 'Disagreement autopilot',
  autopilot: 'Autopilot', decision: 'Decision output',
  report_interim: 'Interim report', report_final: 'Final report', meeting_minutes: 'Meeting minutes',
};

const PRESENTATION_MODES = new Set(['opening', 'round2', 'round3', 'crosstalk', 'reply', 'custom', 'dive_deeper']);

const has = (v) => v !== undefined && v !== null && v !== '';

/**
 * What one model call was for. `mode` is the runTurn mode; the rest say which
 * thread a turn belongs to, since the same mode serves several features.
 * Returns { category, feature }.
 */
function classify({ mode, question_id, disagreement_n, autopilot_scope, report_kind } = {}) {
  if (mode === 'questions_check') return { category: 'question_resolution', feature: 'questions_check' };
  if (mode === 'meeting_minutes') return { category: 'meeting_minutes', feature: 'meeting_minutes' };
  if (mode === 'report') return { category: 'reports', feature: report_kind === 'final' ? 'report_final' : 'report_interim' };
  if (mode === 'decision') return { category: 'reports', feature: 'decision' };
  if (mode === 'autopilot') {
    if (has(question_id) || autopilot_scope === 'question') return { category: 'question_resolution', feature: 'question_discussion' };
    if (has(disagreement_n) || autopilot_scope === 'disagreement') return { category: 'disagreement_resolution', feature: 'disagreement_autopilot' };
    return { category: 'autopilot', feature: 'autopilot' };
  }
  if (PRESENTATION_MODES.has(mode)) {
    // "Discuss" on a disagreement runs a custom meeting about it.
    if (mode === 'custom' && has(disagreement_n)) return { category: 'disagreement_resolution', feature: 'disagreement_discussion' };
    return { category: 'agent_presentation', feature: mode };
  }
  return { category: 'other', feature: mode || 'unknown' };
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const parseJson = (s) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };

// A transcript message that cost something (or failed) but predates the ledger.
function legacyCallFromMessage(m, runsById) {
  const cj = parseJson(m.content_json) || {};
  const ap = cj.autopilot || {};
  const run = ap.run_id != null ? runsById.get(String(ap.run_id)) : null;
  // A Final report's transcript copy is stored with mode 'decision'; its
  // report_id says what it really is.
  const { category, feature } = cj.report_id != null
    ? classify({ mode: 'report', report_kind: 'final' })
    : classify({
      mode: m.mode, question_id: ap.question_id,
      disagreement_n: run ? run.disagreement_n : null, autopilot_scope: run ? run.scope : null,
    });
  const u = cj.usage || {};
  return {
    source: 'transcript', created_at: m.created_at, category, feature, speaker: m.speaker,
    model: cj.model || null, requests: num(u.requests), input_tokens: num(m.input_tokens), output_tokens: num(m.output_tokens),
    searches: num(m.searches), cost_usd: num(m.cost_usd), duration_ms: m.duration_ms == null ? null : num(m.duration_ms),
    error: m.error || null, message_id: m.id,
  };
}

function legacyCallFromReport(r) {
  return {
    source: 'transcript', created_at: r.created_at, category: 'reports', feature: r.kind === 'final' ? 'report_final' : 'report_interim',
    speaker: 'moderator', model: r.model || null, requests: 0, input_tokens: 0, output_tokens: 0, searches: 0,
    cost_usd: num(r.cost_usd), duration_ms: null, error: null, report_id: r.id,
  };
}

function emptyTotals() { return { cost_usd: 0, calls: 0, failed_calls: 0, requests: 0, input_tokens: 0, output_tokens: 0, searches: 0 }; }
function addTo(t, c) {
  t.cost_usd += num(c.cost_usd);
  t.calls += 1;
  if (c.error) t.failed_calls += 1;
  t.requests += num(c.requests);
  t.input_tokens += num(c.input_tokens);
  t.output_tokens += num(c.output_tokens);
  t.searches += num(c.searches);
}
function grouped(calls, keyOf, labelOf) {
  const map = new Map();
  for (const c of calls) {
    const key = keyOf(c);
    if (!map.has(key)) map.set(key, { key, label: labelOf(key), ...emptyTotals() });
    addTo(map.get(key), c);
  }
  return [...map.values()].sort((a, b) => b.cost_usd - a.cost_usd || b.calls - a.calls);
}

/**
 * calls: llm_calls rows, or null when the ledger table is unavailable.
 * messages, reports, autopilotRuns: the session's rows, for pre-ledger usage.
 */
function summarise({ calls, messages = [], reports = [], autopilotRuns = [], recentLimit = 200 }) {
  const ledger = (calls || []).map((c) => ({ ...c, source: 'ledger' }));
  const loggedMessages = new Set(ledger.filter((c) => c.message_id != null).map((c) => String(c.message_id)));
  const loggedReports = new Set(ledger.filter((c) => c.report_id != null).map((c) => String(c.report_id)));
  const runsById = new Map(autopilotRuns.map((r) => [String(r.id), r]));

  const legacy = [];
  for (const m of messages) {
    if (loggedMessages.has(String(m.id))) continue;
    const cj = parseJson(m.content_json);
    // A Final report's transcript copy carries the same cost as its report
    // row: count whichever one the ledger has not, and never both.
    const reportId = cj && cj.report_id != null ? String(cj.report_id) : null;
    if (reportId && loggedReports.has(reportId)) continue;
    const spent = num(m.cost_usd) || num(m.input_tokens) || num(m.output_tokens);
    // Only rows a model call wrote: human and system notes have no cost and no
    // tokens, and a failed turn is recorded even at zero cost.
    if (!spent && !(m.error && m.role !== 'user' && m.role !== 'system')) continue;
    if (reportId) loggedReports.add(reportId);
    legacy.push(legacyCallFromMessage(m, runsById));
  }
  for (const r of reports) {
    if (loggedReports.has(String(r.id)) || !num(r.cost_usd)) continue;
    legacy.push(legacyCallFromReport(r));
  }

  const all = ledger.concat(legacy).map((c) => ({
    ...c,
    category: CATEGORY_LABEL[c.category] ? c.category : 'other',
    category_label: CATEGORY_LABEL[CATEGORY_LABEL[c.category] ? c.category : 'other'],
    feature_label: FEATURE_LABEL[c.feature] || c.feature,
    model: c.model || 'unknown',
  }));
  const total = emptyTotals();
  for (const c of all) addTo(total, c);

  const byCategory = grouped(all, (c) => c.category, (k) => CATEGORY_LABEL[k])
    .map((g) => ({ ...g, features: grouped(all.filter((c) => c.category === g.key), (c) => c.feature, (k) => FEATURE_LABEL[k] || k) }));
  // node-pg returns timestamptz as Date objects, the test fixtures as strings.
  const when = (c) => { const t = new Date(c.created_at).getTime(); return Number.isFinite(t) ? t : 0; };
  const recent = all.slice().sort((a, b) => when(b) - when(a)).slice(0, recentLimit);

  return {
    total,
    by_category: byCategory,
    by_model: grouped(all, (c) => c.model, (k) => k),
    by_agent: grouped(all, (c) => c.speaker || 'unknown', (k) => k),
    calls: recent,
    call_count: all.length,
    ledger_available: Array.isArray(calls),
    legacy_calls: legacy.length,
  };
}

module.exports = { CATEGORIES, FEATURE_LABEL, classify, summarise };
