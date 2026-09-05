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
    out.push({ title: stripTags(a[2]), url, snippet: sn ? stripTags(sn[1]) : '' });
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
  return ((data.web && data.web.results) || []).slice(0, max).map((r) => ({ title: r.title, url: r.url, snippet: stripTags(r.description || ''), age: r.age || r.page_age }));
}

async function searchTavily(query, max) {
  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, max_results: max, search_depth: 'basic' }),
  });
  if (!res.ok) throw new Error(`Tavily Search returned HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0, max).map((r) => ({ title: r.title, url: r.url, snippet: stripTags(r.content || '') }));
}

async function webSearch(query, max = config.SEARCH.max_results) {
  const provider = config.SEARCH.provider;
  const results = provider === 'tavily' ? await searchTavily(query, max)
    : provider === 'brave' ? await searchBrave(query, max)
      : await searchDuckDuckGo(query, max);
  return { provider, query, results };
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
  if (!res.ok) return { url, status: res.status, title: '', text: `HTTP ${res.status} when fetching this page.` };
  if (type.includes('application/pdf')) return { url, status: res.status, title: '', text: 'This URL is a PDF; the tool cannot read PDFs. Cite the URL only if the search snippet or another page confirms the claim.' };
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
  html = html.replace(/<(script|style|noscript|svg|nav|footer|header|iframe)[\s\S]*?<\/\1>/gi, ' ');
  html = html.replace(/<!--[\s\S]*?-->/g, ' ');
  html = html.replace(/<\/(p|div|li|tr|h[1-6]|br|section|article|td|th)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  let text = decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  const max = config.SEARCH.page_chars;
  if (text.length > max) text = text.slice(0, max) + `\n…[truncated at ${max} characters of ${text.length}]`;
  else if (truncatedBody) text += '\n…[page body was larger than the fetch limit; truncated]';
  return { url: res.url || url, status: res.status, title: stripTags(title), text };
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web. Returns up to 8 results with title, URL and snippet. Use specific queries (regulator name, product, year). Search in English and, where useful, in the local language.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open a web page and return its readable text (truncated). Use it to confirm a claim before tagging it VERIFIED, and to read primary sources such as regulator pages, gazettes, guidelines and journal abstracts.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'Absolute http(s) URL from a search result' } }, required: ['url'] },
    },
  },
];

module.exports = { webSearch, openUrl, TOOLS };
