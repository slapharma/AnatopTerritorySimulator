// Checks for the source-preview endpoint's gate and reply shape, with the page
// fetch stubbed. Run with `npm run test:source-preview`.
//
// The first case is the one that matters: without the gate this endpoint is an
// authenticated fetch proxy, so it is asserted against a URL the session has
// never seen, and the stub records whether the fetch was attempted at all.
const { buildPreview, sameUrl, makeCache } = require('../src/source-preview');

let fails = 0;
const check = async (name, fn) => {
  let r;
  try { r = await fn(); } catch (e) { r = `threw ${e.message}`; }
  if (r !== true) { fails++; console.log('FAIL', name, '->', r); } else console.log('pass', name);
};

const PAGE_TEXT = [
  'Ministry of Health of Anatop — Marketing authorisation procedures.',
  'Applications are reviewed by the National Medicines Agency. The standard national procedure takes 210 days from validation to decision, excluding clock stops.',
  'An abridged procedure is available for products already approved in a reference country, and takes 120 days.',
].join('\n');

const SOURCES = [{ n: 1, url: 'https://health.example.gov/procedures', title: 'Procedures', kind: 'cited', cited_by_json: '[{"speaker":"regulatory"}]', first_message_id: 7 }];
const MESSAGES = [{ role: 'agent', text: 'See https://gazette.example.gov/2025/17 for the fee schedule.' }];
const CLAIM = 'The national procedure takes 210 days from validation to decision, excluding clock stops.';

function stubPage(over = {}) {
  const calls = [];
  const fetchPage = async (url) => { calls.push(url); return { url, title: 'Procedures', published: '2025-02-11', blocked: false, text: PAGE_TEXT, ...over }; };
  return { fetchPage, calls };
}

(async () => {
  await check('a URL the session has never seen is refused, and never fetched', async () => {
    const { fetchPage, calls } = stubPage();
    const r = await buildPreview({ url: 'http://169.254.169.254/latest/meta-data/', claim: CLAIM, sources: SOURCES, messages: MESSAGES, fetchPage, cache: makeCache() });
    if (r.status !== 403) return `status ${r.status}`;
    return calls.length === 0 ? true : `fetched anyway: ${calls.join()}`;
  });

  await check('a URL written in a message, but not a source row, is allowed', async () => {
    const { fetchPage } = stubPage();
    const r = await buildPreview({ url: 'https://gazette.example.gov/2025/17', claim: CLAIM, sources: SOURCES, messages: MESSAGES, fetchPage, cache: makeCache() });
    return r.status === 200 && !r.body.source ? true : JSON.stringify(r).slice(0, 120);
  });

  await check('a non-http URL is rejected before anything else happens', async () => {
    const { fetchPage, calls } = stubPage();
    const r = await buildPreview({ url: 'file:///etc/passwd', claim: CLAIM, sources: SOURCES, messages: MESSAGES, fetchPage, cache: makeCache() });
    return r.status === 400 && calls.length === 0 ? true : `status ${r.status}, calls ${calls.length}`;
  });

  await check('a known source returns its number, kind and citing agents', async () => {
    const { fetchPage } = stubPage();
    const r = await buildPreview({ url: 'https://health.example.gov/procedures', claim: CLAIM, sources: SOURCES, messages: [], fetchPage, cache: makeCache() });
    const s = r.body.source;
    return s && s.n === 1 && s.kind === 'cited' && s.cited_by[0].speaker === 'regulatory' ? true : JSON.stringify(s);
  });

  await check('the matching passage comes back highlighted', async () => {
    const { fetchPage } = stubPage();
    const r = await buildPreview({ url: 'https://health.example.gov/procedures', claim: CLAIM, sources: SOURCES, messages: [], fetchPage, cache: makeCache() });
    const ex = r.body.excerpt;
    if (!ex) return `no excerpt: ${r.body.note}`;
    return ex.match.includes('210 days') && !ex.match.includes('120 days') ? true : `matched: ${ex.match}`;
  });

  await check('a claim the page does not support gets a note, not a highlight', async () => {
    const { fetchPage } = stubPage();
    const r = await buildPreview({ url: 'https://health.example.gov/procedures', claim: 'Reimbursement is decided by the regional insurance boards within 60 days of listing.', sources: SOURCES, messages: [], fetchPage, cache: makeCache() });
    return r.body.excerpt === null && /No passage/.test(r.body.note || '') ? true : JSON.stringify(r.body).slice(0, 160);
  });

  await check('a blocked page says so and does not pretend to match', async () => {
    const { fetchPage } = stubPage({ blocked: true, text: 'Cookies must be enabled' });
    const r = await buildPreview({ url: 'https://health.example.gov/procedures', claim: CLAIM, sources: SOURCES, messages: [], fetchPage, cache: makeCache() });
    return r.body.blocked === true && r.body.excerpt === null && Boolean(r.body.note) ? true : JSON.stringify(r.body).slice(0, 160);
  });

  await check('a fetch that throws is reported, not swallowed', async () => {
    const fetchPage = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
    const r = await buildPreview({ url: 'https://health.example.gov/procedures', claim: CLAIM, sources: SOURCES, messages: [], fetchPage, cache: makeCache() });
    return r.status === 200 && r.body.blocked === true && /ENOTFOUND/.test(r.body.note) ? true : JSON.stringify(r.body).slice(0, 160);
  });

  await check('the second look at the same URL is served from cache', async () => {
    const { fetchPage, calls } = stubPage();
    const cache = makeCache();
    const args = { url: 'https://health.example.gov/procedures', claim: CLAIM, sources: SOURCES, messages: [], fetchPage, cache };
    await buildPreview(args);
    await buildPreview(args);
    return calls.length === 1 ? true : `fetched ${calls.length} times`;
  });

  await check('trailing slash, www and protocol do not hide a known source', () => {
    return sameUrl('https://health.example.gov/procedures', 'http://www.health.example.gov/procedures/') ? true : 'not matched';
  });

  await check('different paths on one host are not treated as the same source', () => {
    return sameUrl('https://health.example.gov/a', 'https://health.example.gov/b') ? 'wrongly matched' : true;
  });

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
