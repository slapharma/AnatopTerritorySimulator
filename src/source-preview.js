'use strict';
// What sits behind a source link in an agent's message: the page it points at,
// and the passage on that page the agent's sentence was drawing on.
//
// Kept out of the route so it can be exercised without a database or the
// network — the gate below is the only thing standing between an authenticated
// user and an arbitrary outbound fetch from this server, so it is worth being
// able to test it directly.
const excerpt = require('./excerpt');

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 40;

// The same URL is written a dozen ways (trailing slash, www, http vs https).
// Compare on a normalised form so a link written in the prose still matches the
// sources row it came from. Host and port must match exactly, and the path is
// compared case-sensitively: servers treat /A and /a as different pages.
function sameUrl(a, b) {
  const norm = (u) => {
    try {
      const p = new URL(String(u));
      return `${p.hostname.replace(/^www\./, '')}:${p.port}${p.pathname.replace(/\/$/, '')}${p.search}`;
    } catch { return null; }
  };
  const na = norm(a);
  return na !== null && na === norm(b);
}

// Only what an agent or the moderator wrote counts as "this session mentions
// the URL". A user's own message does not: anyone signed in can post one, so
// accepting it would let them point this server at any page they like.
// (Stored roles, as written by app.js: 'agent', 'moderator', 'user', 'system'.)
const AUTHORED_ROLES = new Set(['agent', 'moderator']);
const URL_IN_TEXT = /https?:\/\/[^\s<>()"'\]\[`]+/gi;

function mentionedUrls(messages) {
  const out = [];
  for (const m of messages) {
    if (!AUTHORED_ROLES.has(m.role)) continue;
    for (const hit of String(m.text || '').match(URL_IN_TEXT) || []) {
      // Sentence punctuation that ends up glued to a bare URL in prose.
      out.push(hit.replace(/[.,;:!?*_]+$/, ''));
    }
  }
  return out;
}

function makeCache() {
  const map = new Map();
  return {
    get(url) {
      const hit = map.get(url);
      if (!hit) return null;
      if (Date.now() - hit.at > TTL_MS) { map.delete(url); return null; }
      return hit.page;
    },
    set(url, page) {
      map.delete(url);
      map.set(url, { at: Date.now(), page });
      // Oldest first: Map iterates in insertion order, and the delete above
      // means a re-fetched URL moves to the back rather than ageing in place.
      while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
    },
    get size() { return map.size; },
  };
}

const defaultCache = makeCache();

/**
 * Build the preview body for one source link.
 *
 * `sources` and `messages` are this session's rows; `fetchPage` is open_url.
 * Resolves to { status, body } — the caller only has to send it.
 */
async function buildPreview({ url, claim, sources = [], messages = [], fetchPage, cache = defaultCache }) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    return { status: 400, body: { error: 'A source preview needs an absolute http(s) URL.' } };
  }

  const source = sources.find((s) => sameUrl(s.url, url)) || null;
  // Only URLs this session already knows about are fetchable. Without that the
  // endpoint is an authenticated fetch proxy: open_url's guard stops it reaching
  // the private network, but nothing would stop it being pointed at a third
  // party from this server's address. A message mention is a whole URL in an
  // agent's or the moderator's text, not a substring of it.
  if (!source && !mentionedUrls(messages).some((u) => sameUrl(u, url))) {
    return { status: 403, body: { error: 'That URL does not appear in this session.' } };
  }

  let page = cache.get(url);
  if (!page) {
    page = await fetchPage(url).catch((e) => ({ url, blocked: true, title: '', text: '', error: e.message }));
    // A failure is not cached: a timeout or a 429 on the first click would
    // otherwise be replayed to every retry for the next ten minutes.
    if (!page.blocked) cache.set(url, page);
  }

  const body = {
    url,
    title: page.title || (source && source.title) || '',
    published: page.published || null,
    blocked: Boolean(page.blocked),
    excerpt: null,
  };
  if (source) {
    body.source = {
      n: source.n,
      kind: source.kind,
      cited_by: parseCitedBy(source),
      first_message_id: source.first_message_id || null,
    };
  }

  if (page.blocked) {
    // Saying which way it failed matters: "the page refused us" and "the page
    // says nothing like that" are different things to a reader checking a claim.
    body.note = page.error
      ? `This page could not be fetched: ${page.error}`
      : page.status >= 400
        ? `The page answered with HTTP ${page.status}, so there is nothing to read.`
        : 'This page did not return readable text — a cookie wall, bot check or PDF answered instead.';
    return { status: 200, body };
  }

  const span = excerpt.findPassage(page.text, claim);
  if (span) {
    body.excerpt = { ...excerpt.withContext(page.text, span), quoted: span.quoted, score: Number(span.score.toFixed(2)) };
  } else {
    body.note = claim
      ? 'No passage on this page matches what the agent said closely enough to highlight.'
      : 'No sentence was sent with this link, so there is nothing to match against the page.';
  }
  return { status: 200, body };
}

// The column is text in the database and already an array once it has been
// through fullSession(); tolerate both rather than depending on the caller.
function parseCitedBy(source) {
  if (Array.isArray(source.cited_by)) return source.cited_by;
  try { return JSON.parse(source.cited_by_json || '[]'); } catch { return []; }
}

module.exports = { buildPreview, sameUrl, makeCache };
