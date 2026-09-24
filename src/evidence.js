'use strict';
// Evidence tags: finding them, checking the VERIFIED ones against what an agent
// actually read, and counting them. Pure (no database, no network), so the turn
// pipeline (transcript.js), the draft check in agents.js, the reports and
// scripts/simulate-session.js all apply exactly the same rules.
//
// A VERIFIED tag must end with words copied from the page:
//   [VERIFIED — source, https://full.url/page, 2026-09-01, "exact words from the page"]
// Opening a page proves nothing about what it says. The 2026-09-24 audit found a
// page that never mentions Korea holding up a claim about Korean regulation, and
// a meta-analysis credited with a result from an unread internal report. So a
// tag stays VERIFIED only when its quote is found in the text open_url returned
// for one of its URLs in this turn, or when the same words (or a longer passage
// containing them) were verified for that URL earlier in the session. Anything
// else is rewritten as an ESTIMATE that says why, so the moderator can see it.

const TAG_RE = /\[(?:VERIFIED|ESTIMATE|UNKNOWN|INTERNAL)\b[^\]]*\]/gi;
const URL_RE = /https?:\/\/[^\s<>()\[\]"']+[^\s<>()\[\]"'.,;:!?]/g;
// Straight and typographic double quotes, plus guillemets. Single quotes are
// left out on purpose: apostrophes inside a quote would split it.
const QUOTE_RE = /["“”„‟«»]([^"“”„‟«»]+)["“”„‟«»]/g;
// "[ESTIMATE (unverified, downgraded from VERIFIED: reason) — …]"; the reason
// part is absent on tags downgraded before reasons were recorded.
const DOWNGRADE_RE = /^\[ESTIMATE\s*\(unverified, downgraded from VERIFIED(?::\s*([^)]*))?\)/i;

const REASONS = {
  noLink: 'no link',
  noQuote: 'no quote from the page',
  shortQuote: 'quote too short to check',
  titleQuote: 'quote is only the page title',
  notOnPage: 'quote not found on the page',
  notThisTurn: 'page not opened this turn',
  neverOpened: 'page never opened',
};

// Case, width, punctuation and spacing differences are not differences in what
// a page says: "KRW 410 million," and "krw 410 million" are the same words.
// Letters and digits of every script survive (\p{L}\p{N}), so Korean quotes work.
function normText(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Two spellings of one page are one page: scheme, a leading www., a trailing
// slash and the #fragment are dropped. The query string is kept, because on
// many regulator sites it is what selects the document.
function normUrl(u) {
  try {
    const x = new URL(String(u).trim());
    const host = x.hostname.toLowerCase().replace(/^www\./, '');
    const path = x.pathname.replace(/\/+$/, '') || '/';
    return `${host}${path}${x.search}`;
  } catch {
    return String(u || '').trim().toLowerCase();
  }
}

// Long enough that it cannot match by accident: four words and twenty
// characters, or twelve characters of Chinese, Japanese or Korean, where one
// character carries what a whole English word does.
function quoteLongEnough(nq) {
  if (/[぀-ヿ㐀-鿿가-힯]/.test(nq)) return nq.length >= 12;
  return nq.split(' ').filter(Boolean).length >= 4 && nq.length >= 20;
}

// The quote is the last quoted passage in the tag, so a source name that is
// itself in quotes ("When Are Bridging Studies Mandatory…") is not taken for it.
function quoteOf(tag) {
  const all = [...String(tag).matchAll(QUOTE_RE)];
  return all.length ? all[all.length - 1][1].trim() : '';
}

// An ellipsis joins passages that are not contiguous on the page; each part
// has to be found on its own. Parts under six characters ("and", "the") are
// connective tissue and are not checked.
function quoteParts(quote) {
  return String(quote).split(/…|\.{3}/).map(normText).filter((p) => p.length >= 6);
}

function urlsOf(tag) {
  return [...String(tag).matchAll(URL_RE)].map((m) => m[0]);
}

// pages: Map(normUrl -> { text, title }) opened in this turn.
// verified: Map(normUrl -> [normalised quotes verified earlier in the session]).
// opened: Set(normUrl) opened anywhere in the session, this turn included.
function checkVerified(tag, { pages = new Map(), verified = new Map(), opened = new Set() } = {}) {
  const urls = urlsOf(tag);
  if (!urls.length) return { ok: false, reason: REASONS.noLink };
  const quote = quoteOf(tag);
  if (!quote) return { ok: false, reason: REASONS.noQuote };
  const parts = quoteParts(quote);
  const longest = parts.reduce((a, b) => (b.length > a.length ? b : a), '');
  if (!longest || !quoteLongEnough(longest)) return { ok: false, reason: REASONS.shortQuote };
  let reason = null;
  for (const url of urls) {
    const key = normUrl(url);
    // Re-used from earlier in the session: the same words, or part of them.
    if ((verified.get(key) || []).some((vq) => parts.every((p) => vq.includes(p)))) return { ok: true, url, quote };
    const page = pages.get(key);
    if (page) {
      if (normText(page.title).includes(longest)) { reason = reason || REASONS.titleQuote; continue; }
      const body = normText(page.text);
      if (parts.every((p) => body.includes(p))) return { ok: true, url, quote };
      reason = REASONS.notOnPage;
      continue;
    }
    if (!reason && opened.has(key)) reason = REASONS.notThisTurn;
  }
  return { ok: false, reason: reason || REASONS.neverOpened };
}

function downgrade(tag, reason) {
  const detail = String(tag).replace(/^\[VERIFIED\b\s*/i, '').replace(/\]$/, '').trim();
  return `[ESTIMATE (unverified, downgraded from VERIFIED: ${reason})${detail ? ` ${detail}` : ''}]`;
}

// What kind of tag this is once the check has run: 'verified', 'downgraded',
// 'estimate', 'unknown' or 'internal'.
function classify(tag) {
  const kw = String(tag).slice(1).split(/\b/)[0].toUpperCase();
  if (kw === 'ESTIMATE') return DOWNGRADE_RE.test(tag) ? 'downgraded' : 'estimate';
  return kw.toLowerCase();
}

function reasonOf(tag) {
  const m = String(tag).match(DOWNGRADE_RE);
  return m ? (m[1] || '').trim() || 'page not opened' : null;
}

// Lines outside the Slides block that state a figure with no tag on the same
// line. A heuristic, reported as a count only: it cannot tell a date in a
// greeting from a fee, but a message with a dozen of these is not evidenced.
function untaggedFigures(text) {
  const body = String(text || '').split(/^#{1,6}\s*Slides\s*$/im)[0];
  // Lines capped before any regex runs: a line of thousands of spaces made the
  // table-separator test below quadratic.
  return body.split(/\r?\n/).map((l) => l.slice(0, 2000)).filter((l) => {
    if (/^\s*#/.test(l) || /^\s*\|?\s*:?-{2,}/.test(l)) return false;
    if (/\[(?:VERIFIED|ESTIMATE|UNKNOWN|INTERNAL)\b/i.test(l)) return false;
    const s = l.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '')
      .replace(/\b(?:Round|Slide|Phase|Position|Question|Step|Option)\s+\d+\b/gi, '')
      .replace(/\[\d+\]/g, '');
    return /\d/.test(s) && /\p{L}{3}/u.test(s);
  }).length;
}

// Runs the VERIFIED check over a whole message. Returns the text as it should
// be stored (VERIFIED tags that fail rewritten as downgraded ESTIMATEs, tag
// keywords upper-cased so every later reader sees one spelling), the counts,
// the quotes that passed, and what failed and why.
function verifyText(text, ctx = {}) {
  const stats = { verified: 0, downgraded: 0, estimate: 0, unknown: 0, internal: 0, untagged_figures: untaggedFigures(text) };
  const pairs = [];
  const failures = [];
  // Models copy the backticks the rules show tags in; a tag in a code span
  // renders as code, not as a badge, so the backticks are dropped.
  const unquoted = String(text || '').replace(/`+(\[(?:VERIFIED|ESTIMATE|UNKNOWN|INTERNAL)\b[^\]`]*\])`+/gi, '$1');
  const out = unquoted.replace(TAG_RE, (raw) => {
    const kw = raw.slice(1).split(/\b/)[0];
    let tag = `[${kw.toUpperCase()}${raw.slice(1 + kw.length)}`;
    if (kw.toUpperCase() === 'VERIFIED') {
      const r = checkVerified(tag, ctx);
      if (r.ok) pairs.push({ url: r.url, quote: r.quote });
      else { failures.push({ tag, reason: r.reason }); tag = downgrade(tag, r.reason); }
    }
    stats[classify(tag)]++;
    return tag;
  });
  return { text: out, stats, verified: pairs, failures };
}

// Counts for text that has already been through verifyText (a stored message).
function countTags(text) {
  const stats = { verified: 0, downgraded: 0, estimate: 0, unknown: 0, internal: 0, untagged_figures: untaggedFigures(text) };
  for (const m of String(text || '').matchAll(TAG_RE)) stats[classify(m[0])]++;
  return stats;
}

function parseContent(m) {
  if (!m || !m.content_json) return {};
  if (typeof m.content_json === 'object') return m.content_json;
  try { return JSON.parse(m.content_json) || {}; } catch { return {}; }
}

// What the session has already established, from every stored message: pages
// opened, URLs seen in search results, and quotes that passed the check. Human
// messages are skipped: a quote typed by a person was never checked against
// anything.
function sessionContext(messages) {
  const opened = new Set();
  const seen = new Set();
  const verified = new Map();
  for (const m of messages || []) {
    if (!m || m.role === 'user' || m.error) continue;
    const c = parseContent(m);
    for (const t of c.trace || []) {
      if (t.type === 'search') for (const r of t.results || []) if (r.url) seen.add(normUrl(r.url));
      if (t.type === 'open') for (const u of [t.url, t.requested_url]) if (u) { opened.add(normUrl(u)); seen.add(normUrl(u)); }
    }
    for (const v of (c.evidence && c.evidence.verified) || []) {
      const key = normUrl(v.url);
      const q = normText(v.quote);
      if (!q) continue;
      if (!verified.has(key)) verified.set(key, []);
      verified.get(key).push(q);
    }
  }
  return { opened, seen, verified };
}

// Adds one turn's own tool use to the session context. pages is the turn's
// Map(normUrl -> {text, title}) from agents.js.
function turnContext(session, trace, pages) {
  const opened = new Set(session ? session.opened : []);
  const seen = new Set(session ? session.seen : []);
  for (const t of trace || []) {
    if (t.type === 'search') for (const r of t.results || []) if (r.url) seen.add(normUrl(r.url));
    if (t.type === 'open') for (const u of [t.url, t.requested_url]) if (u) { opened.add(normUrl(u)); seen.add(normUrl(u)); }
  }
  return { opened, seen, verified: (session && session.verified) || new Map(), pages: pages || new Map() };
}

// ---------- the evidence register (reports) ----------

// The line a tag sits on, as plain text: the claim it is attached to. A tag
// on a line of its own belongs to the line above it.
function claimAround(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const endNl = text.indexOf('\n', index);
  const claim = plainLine(text.slice(start, endNl < 0 ? text.length : endNl));
  if (claim.length >= 15 || start === 0) return claim;
  const above = text.slice(0, start).split('\n').map(plainLine).filter(Boolean);
  return above.length ? above[above.length - 1] : claim;
}

function plainLine(line) {
  // Capped for the same reason as untaggedFigures: the trailing-punctuation
  // trim below is quadratic on a pathological line. A claim is shown at 240.
  return line.slice(0, 2000)
    .replace(TAG_RE, ' ')
    .replace(/\[\d+\]/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*(?:#{1,6}|[-*•]|\d+[.)])\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s·(]+|[\s·(,;:]+$/g, '')
    .trim()
    .slice(0, 240);
}

function sourceName(tag) {
  const body = String(tag).replace(DOWNGRADE_RE, '').replace(/^\[\w+\b/i, '').replace(/\]$/, '');
  const first = body.replace(/^\s*[—–:-]\s*/, '').split(/,\s*(?=https?:)/)[0];
  return first.replace(QUOTE_RE, '').replace(/\s+/g, ' ').replace(/[,\s—–-]+$/, '').trim().slice(0, 120);
}

// Every tag in the panel's messages, as rows. The Moderator Assistant's own
// output is left out: the register is what the agents established, not what a
// report later said about it.
function evidenceRegister(messages, labelOf = (k) => k) {
  const rows = [];
  for (const m of messages || []) {
    if (!m || m.role !== 'agent' || m.error || !m.text) continue;
    for (const t of m.text.matchAll(TAG_RE)) {
      const tag = t[0];
      rows.push({
        seq: m.seq, speaker: m.speaker, agent: labelOf(m.speaker), mode: m.mode,
        kind: classify(tag), reason: reasonOf(tag), claim: claimAround(m.text, t.index),
        source: sourceName(tag), urls: urlsOf(tag), quote: quoteOf(tag),
      });
    }
  }
  const byAgent = new Map();
  for (const r of rows) {
    if (!byAgent.has(r.agent)) byAgent.set(r.agent, { verified: 0, downgraded: 0, estimate: 0, unknown: 0, internal: 0 });
    byAgent.get(r.agent)[r.kind]++;
  }
  const totals = { verified: 0, downgraded: 0, estimate: 0, unknown: 0, internal: 0 };
  for (const r of rows) totals[r.kind]++;
  return { rows, byAgent, totals };
}

const cell = (s) => String(s || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
function dedupe(rows, key) {
  const seen = new Set();
  return rows.filter((r) => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; });
}

// The register as Markdown, appended by the app to every report so the evidence
// section is compiled from the transcript rather than retyped by a model.
function registerMarkdown(reg, depth = 'standard') {
  const t = reg.totals;
  const lines = [
    '## Evidence register (compiled by the app from the transcript)',
    '',
    'Every evidence tag the agents wrote, counted and listed by the app, not by a model. VERIFIED means the agent opened the page and quoted words the app found on it. That shows the page says those words; it does not make the page authoritative, and a quote can still be attached to the wrong claim, so read the quote against the claim.',
    '',
    `**In total:** ${t.verified} VERIFIED · ${t.downgraded} downgraded to ESTIMATE · ${t.estimate} ESTIMATE · ${t.unknown} UNKNOWN · ${t.internal} INTERNAL.`,
    '',
    '| Agent | VERIFIED | Downgraded | ESTIMATE | UNKNOWN | INTERNAL |',
    '|---|---|---|---|---|---|',
    ...[...reg.byAgent.entries()].map(([a, c]) => `| ${cell(a)} | ${c.verified} | ${c.downgraded} | ${c.estimate} | ${c.unknown} | ${c.internal} |`),
  ];
  if (depth === 'brief') return lines.join('\n');
  const verified = dedupe(reg.rows.filter((r) => r.kind === 'verified'), (r) => `${normUrl(r.urls[0] || '')}\n${normText(r.quote)}`);
  lines.push('', '### Verified claims', '');
  if (!verified.length) lines.push('None. No claim in the transcript carries a quote the app could find on the page it cites.');
  else {
    lines.push('| # | Claim | Agent | Source | Words on the page | Link |', '|---|---|---|---|---|---|');
    verified.forEach((r, i) => lines.push(`| ${i + 1} | ${cell(r.claim)} | ${cell(r.agent)} · #${r.seq} | ${cell(r.source)} | “${cell(r.quote)}” | ${r.urls[0] || ''} |`));
  }
  if (depth !== 'full') return lines.join('\n');
  const list = (kind, title, withReason) => {
    const rows = dedupe(reg.rows.filter((r) => r.kind === kind), (r) => normText(r.claim)).slice(0, 80);
    lines.push('', `### ${title}`, '');
    if (!rows.length) { lines.push('None.'); return; }
    for (const r of rows) lines.push(`- ${cell(r.claim) || '(no claim text)'} (${cell(r.agent)}, #${r.seq}${withReason && r.reason ? `; ${r.reason}` : ''}${r.source ? `; ${cell(r.source)}` : ''})`);
  };
  list('downgraded', 'Downgraded from VERIFIED: treat as estimates', true);
  list('unknown', 'UNKNOWN: needs an in-market expert', false);
  list('internal', 'INTERNAL: rests on company material no agent could read', false);
  list('estimate', 'ESTIMATE', false);
  return lines.join('\n');
}

module.exports = {
  TAG_RE, URL_RE, REASONS,
  normText, normUrl, quoteOf, urlsOf, checkVerified, downgrade, classify, reasonOf,
  untaggedFigures, verifyText, countTags, sessionContext, turnContext,
  evidenceRegister, registerMarkdown,
};
