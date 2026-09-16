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

module.exports = { parseQuestions, addresseeKeys, parseQuestionStatus, parseAnsweredCheck, isAnsweredCheckReadable, answeredListLength, STATUSES };
