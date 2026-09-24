'use strict';
// Turns one turn's raw model text into the text the app actually stores:
// checks every VERIFIED tag against what was read (src/evidence.js), registers
// every searched, opened and cited URL as a session source, and numbers the
// citations.
//
// Its own module rather than a function inside app.js so a harness can measure
// what the product ships without requiring app.js — which calls app.listen() at
// import time, so requiring it to reach one function would start a second server
// on the configured port and hold the process open.
const db = require('./db');
const evidence = require('./evidence');

const { TAG_RE, URL_RE, normUrl } = evidence;

// ctx is what the session had established before this turn
// (evidence.sessionContext) plus `pages`, the text of every page this turn
// opened (agents.runTurn's result.pages). With no ctx a VERIFIED tag can only
// stand on a page opened in this very turn.
//
// Source kinds: 'searched' (appeared in search results), 'cited' (opened, or
// cited in the text and known to exist from a search or an open somewhere in
// the session) and 'unverified' (cited in the text but never searched or opened
// by anyone, so possibly invented; the 2026-09-24 audit found 17 of 17 such
// URLs from one model, 16 of them dead). register: false checks the tags and
// leaves the sources table alone (meeting minutes restate; they add no sources).
//
// Returns { text, evidence }: evidence is the counts and the quotes that passed,
// for the message's content_json.
async function assembleText(sessionId, messageId, speaker, text, trace, ctx = {}, { register = true } = {}) {
  const titles = new Map();
  const upsert = register ? (fields) => db.upsertSource(sessionId, { ...fields, messageId, speaker }) : async () => null;
  for (const t of trace || []) {
    if (t.type === 'search') for (const r of t.results || []) { if (r.url) { titles.set(r.url, r.title); await upsert({ url: r.url, title: r.title, kind: 'searched' }); } }
    if (t.type === 'open' && t.url) { if (t.title) titles.set(t.url, t.title); await upsert({ url: t.url, title: t.title, kind: 'cited' }); }
  }
  const turn = evidence.turnContext(ctx, trace, ctx.pages);
  const checked = evidence.verifyText(text, turn);

  const citeCache = new Map();
  async function cite(url) {
    if (citeCache.has(url)) return citeCache.get(url);
    const n = await upsert({ url, title: titles.get(url), kind: turn.seen.has(normUrl(url)) ? 'cited' : 'unverified' });
    citeCache.set(url, n);
    return n;
  }
  // Pass 1: tags. Append [n] after the closing bracket for each URL inside,
  // outside the brackets so the badge still renders.
  const tagMatches = [...checked.text.matchAll(TAG_RE)];
  const tagReplacements = new Map();
  for (const m of tagMatches) {
    const tag = m[0];
    if (tagReplacements.has(tag)) continue;
    const nums = [];
    for (const um of tag.matchAll(URL_RE)) { const n = await cite(um[0]); if (n != null && !nums.includes(n)) nums.push(n); }
    tagReplacements.set(tag, nums.length ? `${tag} ${nums.map((n) => `[${n}]`).join('')}` : tag);
  }
  // A tag copied from the transcript already carries its markers ("[…] [4]").
  // When the tag has URLs its markers are rebuilt, so the old ones are
  // swallowed rather than doubled; a tag without URLs keeps whatever follows it.
  let out = checked.text.replace(new RegExp(`${TAG_RE.source}(?:[ \\t]*\\[\\d+\\])*`, 'gi'), (whole) => {
    const tag = whole.match(TAG_RE)[0];
    const replacement = tagReplacements.get(tag);
    return replacement && replacement !== tag ? replacement : whole;
  });
  // Pass 2: bare URLs outside tags.
  const parts = out.split(TAG_RE);
  const tags = out.match(TAG_RE) || [];
  const newParts = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    let s = seg;
    for (const um of seg.matchAll(URL_RE)) {
      const url = um[0];
      const after = seg.slice(um.index + url.length, um.index + url.length + 6);
      if (/^\)?\s*\[\d+\]/.test(after)) continue; // already marked
      if (seg.slice(Math.max(0, um.index - 2), um.index).endsWith('](')) continue; // Markdown link target
      const n = await cite(url);
      if (n != null) s = s.replace(url, `${url} [${n}]`);
    }
    newParts.push(s + (tags[i] || ''));
  }
  out = newParts.join('');
  // counts: tags by kind after the check; verified: the {url, quote} pairs that
  // passed, which evidence.sessionContext reads back so later turns can re-use
  // them; failures: why each failed VERIFIED tag was downgraded.
  return {
    text: out.trim(),
    evidence: { counts: checked.stats, verified: checked.verified, failures: checked.failures.map((f) => f.reason) },
  };
}

module.exports = { assembleText };
