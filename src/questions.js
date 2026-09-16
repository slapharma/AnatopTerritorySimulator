'use strict';
// Agent Questions: pulls the "Questions for <X>:" blocks agents are told to end
// a message with (prompts/evidence-rules.md) out of a response, one entry per
// numbered or bulleted item. Pure, so it can be tested without a database.

// A heading line such as "Questions for Ruth:", "**Questions for the Moderator**",
// "### Questions for Luca and Charlie". The addressee part is everything after
// "for", up to an optional trailing colon and emphasis.
const HEAD_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*questions?\s+for\s+(.+?)\s*(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*$/i;
const ITEM_RE = /^\s*(?:\d+[.)]|[-*•])\s+(.*\S)\s*$/;
const HEADING_RE = /^\s*#{1,6}\s/;

const MODERATOR_WORDS = /^(?:the\s+)?(?:moderator|human|chair|you)$/i;

function stripEmphasis(s) {
  return String(s).replace(/\*\*|__/g, '').replace(/^\s*[*_]|[*_]\s*$/g, '').trim();
}

// Maps the addressee phrase to keys: agent keys from `agents` (the prompts
// roster, keyed by agent key with name/short/function/label) and 'moderator'.
// Unrecognised names are dropped.
function addresseeKeys(phrase, agents) {
  const parts = stripEmphasis(phrase)
    .replace(/[()]/g, ' ')
    .split(/\s*(?:,|\/|&|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const keys = [];
  const add = (k) => { if (!keys.includes(k)) keys.push(k); };
  for (const part of parts) {
    if (MODERATOR_WORDS.test(part)) { add('moderator'); continue; }
    const lower = part.toLowerCase().replace(/^the\s+/, '');
    if (/^(?:all|everyone|all agents|the panel|panel)$/.test(lower)) {
      for (const k of Object.keys(agents)) add(k);
      continue;
    }
    for (const [key, a] of Object.entries(agents)) {
      const names = [a.name, a.short, a.function, a.label, key].filter(Boolean).map((x) => String(x).toLowerCase());
      if (names.some((n) => lower === n || lower.split(/\s+/).includes(n))) { add(key); break; }
    }
  }
  return keys;
}

// Returns [{ addressees: [...keys], n, text }] in message order. n numbers the
// questions across the whole message from 1, so (message, n) identifies one.
// `asker` is excluded from the addressees: an agent cannot owe itself an answer.
function parseQuestions(text, agents, asker) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const head = HEAD_RE.exec(lines[i]);
    if (!head) { i++; continue; }
    const addressees = addresseeKeys(head[1], agents).filter((k) => k !== asker);
    i++;
    let current = null;
    let blankRun = 0;
    const items = [];
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (HEAD_RE.test(line) || HEADING_RE.test(line)) break;
      if (!line.trim()) { blankRun++; if (blankRun > 1 && items.length) break; continue; }
      const item = ITEM_RE.exec(line);
      if (item) { current = { text: stripEmphasis(item[1]) }; items.push(current); blankRun = 0; continue; }
      // A wrapped continuation of the item above; anything else after a blank
      // line ends the block.
      if (current && blankRun === 0) { current.text = `${current.text} ${stripEmphasis(line)}`; continue; }
      if (!items.length && blankRun === 0 && !current) { current = { text: stripEmphasis(line) }; items.push(current); continue; }
      break;
    }
    if (!addressees.length) continue;
    for (const it of items) {
      if (!it.text) continue;
      out.push({ addressees, n: out.length + 1, text: it.text.slice(0, 2000) });
    }
  }
  return out;
}

// Pulls the verdict line an asker ends a question discussion with.
// The last one counts: an asker may quote an earlier loop's verdict in the body.
function parseQuestionStatus(text) {
  const all = [...String(text || '').matchAll(/QUESTION STATUS:\s*\**\s*(RESOLVED|OPEN)\b/gi)];
  return all.length ? all[all.length - 1][1].toUpperCase() : null;
}

// The Moderator Assistant's answered-check reply: a JSON object, possibly
// wrapped in a code fence or prose. Returns [{ id, seq, note }] or [].
function parseAnsweredCheck(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let obj;
  try { obj = JSON.parse(s.slice(start, end + 1)); } catch { return []; }
  const list = Array.isArray(obj && obj.answered) ? obj.answered : [];
  return list
    .map((x) => ({ id: String(x && x.id != null ? x.id : ''), seq: Number(x && x.seq), note: String((x && x.note) || '').slice(0, 300) }))
    .filter((x) => /^\d+$/.test(x.id));
}

// True when the reply holds the JSON object the check asks for (an "answered"
// list, even an empty one), so a log can tell "none answered" from "unreadable".
function isAnsweredCheckReadable(text) {
  return answeredListLength(text) >= 0;
}
// How many entries the reply's "answered" list holds before any are dropped
// as malformed, or -1 when there is no readable list.
function answeredListLength(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return -1;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(obj && obj.answered) ? obj.answered.length : -1;
  } catch { return -1; }
}

const STATUSES = ['open', 'answered', 'resolved', 'escalated'];

// ---------- minutes entries ----------
// Every action on a question leaves a record in the session's minutes. The
// entry is built from data, not written by a model: it is instant, free, and
// says exactly what happened.
const STATUS_LABEL = { open: 'Open', answered: 'Answered', resolved: 'Resolved', escalated: 'Escalated to moderator' };
const ROUND_LABEL = {
  opening: 'Baselines', round2: 'Challenge', round3: 'Converge', crosstalk: 'Cross-talk', reply: 'Reply',
  custom: 'Custom meeting', autopilot: 'Autopilot', dive_deeper: 'Dive Deeper', decision: 'Decision output',
};
const OUTCOME_LABEL = {
  resolved: 'resolved by the asker', cycle_cap: 'loop limit reached', safety_cap: 'safety loop cap reached',
  cost_cap: 'cost limit reached', failed: 'a turn failed', stopped_by_moderator: 'stopped by the moderator',
};
const MINUTES_ROUND = 'question';

function autopilotOf(m) {
  if (!m || !m.content_json) return null;
  try { return JSON.parse(m.content_json).autopilot || null; } catch { return null; }
}
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// action: 'answer' (the moderator answered it), 'check' (the answered-check
// found it answered), 'status' (marked answered / escalated / reopened by hand)
// or 'discussion' (a discuss-to-resolution run ended; discussion is
// { run_id, outcome, cycles }). from/to are statuses. label maps an agent key to
// a display name. Returns { label, text, anchor_message_id }.
function questionMinutes({ question, action, from, to, note, answerMessage, discussion, messages = [], label }) {
  const name = (k) => label(k);
  const byId = new Map(messages.map((m) => [String(m.id), m]));
  const asked = byId.get(String(question.message_id));
  const addressees = String(question.addressees || '').split(',').filter(Boolean);
  const pair = `${name(question.asker)} → ${addressees.map(name).join(', ') || 'unaddressed'}`;
  const ref = (m) => (m ? ` in message #${m.seq}` : '');

  let verb;
  let happened;
  const extra = [];
  let anchor = answerMessage || asked || null;
  if (action === 'answer') {
    verb = 'answered by the moderator';
    happened = `The moderator answered it${ref(answerMessage)}.`;
  } else if (action === 'check') {
    verb = 'found answered';
    happened = `The Moderator Assistant found it answered${ref(answerMessage)}.`;
  } else if (action === 'discussion') {
    const d = discussion || {};
    const outcome = OUTCOME_LABEL[d.outcome] || 'stopped';
    verb = `discussed: ${from === to ? outcome : STATUS_LABEL[to].toLowerCase()}`;
    const cycles = Number.isFinite(Number(d.cycles)) ? Number(d.cycles) : 0;
    happened = `Discussed to resolution over ${cycles} loop${cycles === 1 ? '' : 's'}: ${outcome}.`;
    const run = messages.filter((m) => {
      const ap = autopilotOf(m);
      return ap && d.run_id != null && String(ap.run_id) === String(d.run_id) && m.role !== 'system';
    });
    const loops = new Map();
    for (const m of run) {
      const cycle = autopilotOf(m).cycle || 1;
      if (!loops.has(cycle)) loops.set(cycle, []);
      loops.get(cycle).push(`${name(m.speaker)} #${m.seq}${m.error ? ' (failed)' : ''}`);
    }
    if (loops.size) {
      extra.push('**Contributions:**');
      for (const [cycle, list] of [...loops.entries()].sort((a, b) => a[0] - b[0])) extra.push(`- Loop ${cycle}: ${list.join(', ')}`);
    }
    const askerTurns = run.filter((m) => m.speaker === question.asker && m.text);
    const lastAsker = askerTurns[askerTurns.length - 1];
    const verdicts = lastAsker ? [...lastAsker.text.matchAll(/QUESTION STATUS:\s*\**\s*((?:RESOLVED|OPEN)\b[^\n]*)/gi)] : [];
    // The blank line stops Markdown reading the verdict as part of the last list item.
    if (verdicts.length) extra.push(...(extra.length ? [''] : []), `**${name(question.asker)}'s verdict:** ${oneLine(verdicts[verdicts.length - 1][1])}`);
    if (answerMessage) anchor = answerMessage;
    else if (run.length) anchor = run[run.length - 1];
  } else {
    verb = to === 'open' ? 'reopened' : to === 'escalated' ? 'escalated' : `marked ${STATUS_LABEL[to].toLowerCase()}`;
    happened = to === 'open' ? 'The moderator reopened it.'
      : to === 'escalated' ? 'The moderator escalated it for offline review.'
        : `The moderator marked it ${STATUS_LABEL[to].toLowerCase()}.`;
  }

  const text = [
    // Not "**Question**": the app's Markdown renderer turns that into a badge.
    `**${name(question.asker)} asked ${addressees.map(name).join(' and ') || 'no one named'}:** "${oneLine(question.text)}"`,
    '',
    `Asked in ${ROUND_LABEL[question.round] || question.round || 'the transcript'}${asked ? `, message #${asked.seq}` : ''}.`,
    '',
    `**What happened:** ${happened}`,
    '',
    from === to ? `**Status:** ${STATUS_LABEL[to]} (unchanged)` : `**Status:** ${STATUS_LABEL[from] || from} → ${STATUS_LABEL[to] || to}`,
    ...(note ? ['', `**Note:** ${oneLine(note)}`] : []),
    ...(extra.length ? ['', ...extra] : []),
  ].join('\n');

  return {
    label: `Question ${verb} · ${pair}`.slice(0, 200),
    text,
    anchor_message_id: anchor && /^\d+$/.test(String(anchor.id)) ? Number(anchor.id) : null,
  };
}

module.exports = {
  parseQuestions, addresseeKeys, parseQuestionStatus, parseAnsweredCheck, isAnsweredCheckReadable, answeredListLength,
  questionMinutes, STATUSES, MINUTES_ROUND,
};
