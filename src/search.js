'use strict';
// Web tools the agents can call: web_search (DuckDuckGo, or Brave if BRAVE_API_KEY is set)
// and open_url (fetch a page and return its readable text).
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

async function webSearch(query, max = config.SEARCH.max_results) {
  const provider = config.SEARCH.provider;
  const results = provider === 'brave' ? await searchBrave(query, max) : await searchDuckDuckGo(query, max);
  return { provider, query, results };
}

// Fetches a page and returns readable text (scripts, styles, nav noise removed).
async function openUrl(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('open_url needs an absolute http(s) URL');
  const res = await fetchWithTimeout(url);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok) return { url, status: res.status, title: '', text: `HTTP ${res.status} when fetching this page.` };
  if (type.includes('application/pdf')) return { url, status: res.status, title: '', text: 'This URL is a PDF; the tool cannot read PDFs. Cite the URL only if the search snippet or another page confirms the claim.' };
  let html = await res.text();
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1];
  html = html.replace(/<(script|style|noscript|svg|nav|footer|header|iframe)[\s\S]*?<\/\1>/gi, ' ');
  html = html.replace(/<!--[\s\S]*?-->/g, ' ');
  html = html.replace(/<\/(p|div|li|tr|h[1-6]|br|section|article|td|th)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  let text = decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  const max = config.SEARCH.page_chars;
  if (text.length > max) text = text.slice(0, max) + `\n…[truncated at ${max} characters of ${text.length}]`;
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
