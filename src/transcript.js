'use strict';
// Turns one agent turn's raw model text into the text the app actually stores:
// registers every searched, opened and cited URL as a session source, numbers the
// citations, and downgrades any VERIFIED tag whose URL was never opened.
//
// Its own module rather than a function inside app.js so a harness can measure
// what the product ships without requiring app.js — which calls app.listen() at
// import time, so requiring it to reach one function would start a second server
// on the configured port and hold the process open.
const db = require('./db');

// Registers every searched / opened / cited URL as a session source and adds [n]
// markers to the text after each URL the agent cited (outside the tag brackets so
// the badge still renders).
const URL_RE = /https?:\/\/[^\s<>()\[\]"']+[^\s<>()\[\]"'.,;:!?]/g;
const TAG_RE = /\[(?:VERIFIED|ESTIMATE|UNKNOWN)\b[^\]]*\]/g;

async function assembleText(sessionId, messageId, speaker, text, trace) {
  const titles = new Map();
  const openedUrls = new Set();
  for (const t of trace) {
    if (t.type === 'search') for (const r of t.results || []) { if (r.url) { titles.set(r.url, r.title); await db.upsertSource(sessionId, { url: r.url, title: r.title, kind: 'searched', messageId, speaker }); } }
    if (t.type === 'open' && t.url) { openedUrls.add(t.url); if (t.title) titles.set(t.url, t.title); await db.upsertSource(sessionId, { url: t.url, title: t.title, kind: 'cited', messageId, speaker }); }
  }
  const citeCache = new Map();
  async function cite(url) {
    if (citeCache.has(url)) return citeCache.get(url);
    const n = await db.upsertSource(sessionId, { url, title: titles.get(url), kind: 'cited', messageId, speaker });
    citeCache.set(url, n);
    return n;
  }
  // Pass 1: tags. Append [n] after the closing bracket for each URL inside.
  // A VERIFIED tag whose URL was never actually opened (only searched, or no
  // URL at all) is downgraded to ESTIMATE — a snippet alone doesn't verify a claim.
  const tagMatches = [...text.matchAll(TAG_RE)];
  const tagReplacements = new Map();
  for (const m of tagMatches) {
    let tag = m[0];
    const tagUrls = [...tag.matchAll(URL_RE)].map((um) => um[0]);
    if (/^\[VERIFIED\b/i.test(tag) && !tagUrls.some((u) => openedUrls.has(u))) {
      tag = tag.replace(/^\[VERIFIED\b/i, '[ESTIMATE (unverified, downgraded from VERIFIED)');
    }
    const nums = [];
    for (const url of tagUrls) { const n = await cite(url); if (!nums.includes(n)) nums.push(n); }
    tagReplacements.set(m[0], nums.length ? `${tag} ${nums.map((n) => `[${n}]`).join('')}` : tag);
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

module.exports = { assembleText };
