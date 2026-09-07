'use strict';
// Web tools the agents can call: web_search (DuckDuckGo, or Brave if BRAVE_API_KEY is set)
// and open_url (fetch a page and return its readable text).
const dns = require('dns').promises;
const net = require('net');
const config = require('./config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LaunchWorkingGroup/1.0 (+local research tool)';

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)));
}
function stripTags(s) { return decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(); }

// The evidence rules require secondary sources to be dated within three years,
// which was unenforceable because nothing carried a date. Providers differ:
// Brave returns page_age, Tavily returns published_date only for its news
// topic, and DuckDuckGo's HTML endpoint returns nothing at all. So a date is
// reported when the provider gives one, and otherwise read off the page itself
// in open_url — which is where it matters, since a snippet alone only ever
// justifies ESTIMATE and VERIFIED requires opening the page.
function toIsoDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  let ms = null;

  // Deliberately not `new Date(raw)` on anything: that parses "1.2.3" as
  // 2 January 2003 and a bare "42" as a year, inventing dates out of version
  // strings and page numbers. Only shapes that are unambiguously dates.
  let m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    // Date-only strings are calendar dates, not instants. Building them in UTC
    // stops toISOString() shifting them a day in a non-UTC timezone.
    ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  } else if (/^\d{4}$/.test(raw)) {
    ms = Date.UTC(Number(raw), 0, 1);
  } else if (/\d{4}/.test(raw) && /[A-Za-z]{3}|T\d{2}:|\d{2}:\d{2}/.test(raw)) {
    // Formats that carry their own timezone: ISO with a time, RFC 1123
    // ("Wed, 25 Mar 2026 04:23:17 GMT"), and similar.
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) ms = d.getTime();
  }
  if (ms === null || Number.isNaN(ms)) return null;

  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (year < 1990 || ms > Date.now() + 86400000) return null;
  return d.toISOString().slice(0, 10);
}

// Ordered best-first: an explicit publication date beats a modification date,
// which beats the server's Last-Modified (often just the last deploy).
function extractPublished(html, headers) {
  const pick = (re) => { const m = html.match(re); return m ? decodeEntities(m[1]) : null; };
  const candidates = [
    ['article:published_time', pick(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)],
    ['citation_publication_date', pick(/<meta[^>]+name=["']citation_publication_date["'][^>]+content=["']([^"']+)["']/i)],
    ['citation_date', pick(/<meta[^>]+name=["']citation_date["'][^>]+content=["']([^"']+)["']/i)],
    ['datePublished', pick(/"datePublished"\s*:\s*"([^"]+)"/i)],
    ['dc.date', pick(/<meta[^>]+name=["'](?:dc\.date|dcterms\.issued|date)["'][^>]+content=["']([^"']+)["']/i)],
    ['pubdate', pick(/<meta[^>]+(?:name|property)=["'](?:pubdate|publish[-_]?date|sailthru\.date)["'][^>]+content=["']([^"']+)["']/i)],
    ['time[datetime]', pick(/<time[^>]+datetime=["']([^"']+)["']/i)],
    ['article:modified_time', pick(/<meta[^>]+property=["']article:modified_time["'][^>]+content=["']([^"']+)["']/i)],
    ['dateModified', pick(/"dateModified"\s*:\s*"([^"]+)"/i)],
  ];
  for (const [source, raw] of candidates) {
    const iso = toIsoDate(raw);
    if (iso) return { published: iso, published_source: source };
  }
  const lastModified = headers && typeof headers.get === 'function' ? headers.get('last-modified') : null;
  const iso = toIsoDate(lastModified);
  // Named so the model can weigh it: a server header is not a byline.
  if (iso) return { published: iso, published_source: 'last-modified header (weak: may be the last deploy, not the publication date)' };
  return { published: null, published_source: null };
}

async function fetchWithTimeout(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), config.SEARCH.timeout_ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', ...(opts.headers || {}) } });
  } finally { clearTimeout(t); }
}

async function searchDuckDuckGo(query, max) {
  const res = await fetchWithTimeout('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query));
  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  const blocks = html.split(/class="result\s/).slice(1);
  for (const b of blocks) {
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decodeEntities(a[1]);
    const m = url.match(/[?&]uddg=([^&]+)/);
    if (m) url = decodeURIComponent(m[1]);
    else if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    // DuckDuckGo's HTML endpoint carries no date; open_url is the only way to get one.
    out.push({ title: stripTags(a[2]), url, snippet: sn ? stripTags(sn[1]) : '', published: null });
    if (out.length >= max) break;
  }
  return out;
}

async function searchBrave(query, max) {
  const res = await fetchWithTimeout(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`, {
    headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Brave Search returned HTTP ${res.status}`);
  const data = await res.json();
  return ((data.web && data.web.results) || []).slice(0, max).map((r) => ({
    title: r.title, url: r.url, snippet: stripTags(r.description || ''),
    age: r.age || r.page_age, published: toIsoDate(r.page_age || r.age),
  }));
}

async function searchTavily(query, max) {
  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, max_results: max, search_depth: 'basic' }),
  });
  if (!res.ok) throw new Error(`Tavily Search returned HTTP ${res.status}`);
  const data = await res.json();
  // Tavily returns published_date only on its news topic, so this is usually
  // null for the regulator, guideline and journal pages this tool mostly hits.
  return (data.results || []).slice(0, max).map((r) => ({
    title: r.title, url: r.url, snippet: stripTags(r.content || ''),
    published: toIsoDate(r.published_date),
  }));
}

async function webSearch(query, max = config.SEARCH.max_results) {
  const provider = config.SEARCH.provider;
  const results = provider === 'tavily' ? await searchTavily(query, max)
    : provider === 'brave' ? await searchBrave(query, max)
      : await searchDuckDuckGo(query, max);
  // Said once per search rather than repeated on every result: without it a
  // model reads a missing date as "recent" instead of "unknown".
  const undated = results.filter((r) => !r.published).length;
  const note = undated
    ? `${undated} of ${results.length} result(s) carry no publication date from this provider. A date of null means UNKNOWN, not recent — open the page to find its date before relying on it for a time-sensitive claim.`
    : undefined;
  return { provider, query, results, note };
}

// IPv4/IPv6 ranges that must never be reachable from open_url: loopback,
// private/link-local (RFC1918 and friends), and the cloud metadata address
// (169.254.169.254) that a lot of real-world SSRF exploits target.
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    return low === '::1' || low === '::' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80') || low.startsWith('::ffff:127.');
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true; // malformed — refuse rather than guess
  const [a, b] = parts;
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// Best-effort SSRF guard: a model told (by a jailbreak, or an instruction
// injected into a page it already opened) to fetch an internal address would
// otherwise turn this server's own network access into an attacker's proxy.
// DNS-rebinding between this check and the actual fetch isn't fully closed —
// that would need a custom low-level connect — but this stops the overwhelmingly
// common case (literal IPs, localhost, cloud metadata, normal private hostnames).
async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('open_url may not target a private or internal address');
    return;
  }
  if (/^localhost$/i.test(hostname)) throw new Error('open_url may not target a private or internal address');
  const addrs = await dns.lookup(hostname, { all: true }).catch(() => []);
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('open_url may not target a private or internal address');
}

const MAX_BODY_BYTES = 3_000_000; // stop reading a huge/hostile response body well before it becomes a memory problem

// Fetches a page and returns readable text (scripts, styles, nav noise removed).
async function openUrl(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('open_url needs an absolute http(s) URL');
  const parsed = new URL(url);
  await assertPublicHost(parsed.hostname);
  const res = await fetchWithTimeout(url);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  // Every open_url result carries `published`, including the failures — an
  // absent field reads as 'not applicable', null reads as 'unknown'.
  if (!res.ok) return { url, status: res.status, title: '', published: null, published_source: null, text: `HTTP ${res.status} when fetching this page.` };
  if (type.includes('application/pdf')) return { url, status: res.status, title: '', published: null, published_source: null, text: 'This URL is a PDF; the tool cannot read PDFs. Cite the URL only if the search snippet or another page confirms the claim.' };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let html = '';
  let bytes = 0;
  let truncatedBody = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > MAX_BODY_BYTES) { truncatedBody = true; reader.cancel().catch(() => {}); break; }
    html += dec.decode(value, { stream: true });
  }
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1];
  // Read the date before the tag-stripping below destroys the meta elements.
  const dated = extractPublished(html, res.headers);
  html = html.replace(/<(script|style|noscript|svg|nav|footer|header|iframe)[\s\S]*?<\/\1>/gi, ' ');
  html = html.replace(/<!--[\s\S]*?-->/g, ' ');
  html = html.replace(/<\/(p|div|li|tr|h[1-6]|br|section|article|td|th)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  let text = decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  const max = config.SEARCH.page_chars;
  if (text.length > max) text = text.slice(0, max) + `\n…[truncated at ${max} characters of ${text.length}]`;
  else if (truncatedBody) text += '\n…[page body was larger than the fetch limit; truncated]';
  return {
    url: res.url || url, status: res.status, title: stripTags(title),
    published: dated.published, published_source: dated.published_source,
    ...(dated.published ? {} : { published_note: 'No publication date found on this page. Treat its age as UNKNOWN; do not describe it as current unless the page itself says so.' }),
    text,
  };
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web. Returns up to 8 results with title, URL, snippet and published (an ISO date, or null when this provider gives none — null means unknown, not recent). Use specific queries (regulator name, product, year). Search in English and, where useful, in the local language.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open a web page and return its readable text (truncated), plus published: the page\'s own publication date where it declares one, and published_source saying which field that came from. Use it to confirm a claim before tagging it VERIFIED, to read primary sources such as regulator pages, gazettes, guidelines and journal abstracts, and to establish how old a source is when search gave no date.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'Absolute http(s) URL from a search result' } }, required: ['url'] },
    },
  },
];

module.exports = { webSearch, openUrl, TOOLS, extractPublished, toIsoDate };
