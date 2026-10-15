'use strict';
// src/app.js: GET /api/sessions/:id/source-preview — the preview behind a
// source link in an agent's message. Real app.js + auth + src/source-preview.js
// + src/excerpt.js, in-memory fake db (test/helpers/start-app.js), and
// search.openUrl replaced with a stub so no network is used. The route reads
// search.openUrl on each request, so replacing it on the module object is seen.
//
// The preview cache in src/source-preview.js is module-level and keyed by URL,
// so every test that counts outbound fetches uses a URL no other test uses.
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startApp, ROOT } = require('./helpers/start-app');

const SESSION_ID = 52;
const USER_ID = 1;

const SOURCE_URL = 'https://example-agency.org/guidance/';
const SOURCE_ROW_URL = 'https://www.example-agency.org/guidance/';
const PAGE_TEXT = 'The agency issues a decision within 120 days of a complete dossier. Fees are 45,000 euros. Reviews are published quarterly.';
const CLAIM = 'The agency decides within 120 days of a complete dossier.';
const MATCHED_SENTENCE = 'The agency issues a decision within 120 days of a complete dossier.';

// Every URL a test asks for is written into a message here, so the session
// "mentions" it. Only the message-level tests depend on the wording.
const MESSAGE_LINKS = [
  'https://msg-only.example.net/rule',
  'https://cache-check.example.org/page',
  'https://fail-fetch.example.org/down',
  'https://pdf.example.org/report.pdf',
  'https://nothing.example.org/page',
  'https://no-claim.example.org/page',
  'https://quoted.example.org/page',
  'https://empty-result.example.org/page',
  'http://example-agency.org/guidance',
];

const SESSION = { id: SESSION_ID, title: 'Anatop · Argentina' };
const SOURCES = [{
  n: 1, url: SOURCE_ROW_URL, title: 'Agency guidance', kind: 'cited',
  cited_by_json: '[{"speaker":"regulatory","mode":"opening"}]', first_message_id: 9,
}];
const MESSAGES = [
  { id: 9, role: 'agent', speaker: 'regulatory', mode: 'opening', seq: 1, error: null,
    text: `Approval takes time. ${MESSAGE_LINKS.map((u) => `[link](${u})`).join(' ')}` },
];

const DEFAULT_PAGE = { title: 'Default page', blocked: false, published: null, text: PAGE_TEXT };

describe('GET /api/sessions/:id/source-preview', () => {
  let server, baseUrl, cookie, searchModule, originalOpenUrl;
  let pages, openUrlCalls, listMessagesCalls, openUrlFailures;

  before(async () => {
    const harness = await startApp({
      countUsers: async () => 1,
      getUserById: async (id) => (Number(id) === USER_ID ? { id: USER_ID, email: 'admin@example.com', is_admin: true } : null),
      getSession: async (id) => (Number(id) === SESSION_ID ? SESSION : null),
      listSources: async (id) => (Number(id) === SESSION_ID ? SOURCES : []),
      listMessages: async (id) => {
        listMessagesCalls.push(id);
        return Number(id) === SESSION_ID ? MESSAGES : [];
      },
    });
    server = harness.server;
    baseUrl = harness.baseUrl;
    cookie = `anatop_session=${harness.auth.mintSession({ id: USER_ID })}`;

    searchModule = require(path.join(ROOT, 'src', 'search'));
    originalOpenUrl = searchModule.openUrl;
    searchModule.openUrl = async (url) => {
      openUrlCalls.push(url);
      if (openUrlFailures.has(url)) throw openUrlFailures.get(url);
      if (url === 'https://empty-result.example.org/page') return undefined;
      return { url, status: 200, published: null, published_source: null, ...(pages.has(url) ? pages.get(url) : DEFAULT_PAGE) };
    };
  });

  beforeEach(() => {
    pages = new Map();
    openUrlCalls = [];
    listMessagesCalls = [];
    openUrlFailures = new Map();
  });

  after(async () => {
    searchModule.openUrl = originalOpenUrl;
    await new Promise((resolve) => server.close(resolve));
  });

  const preview = (params, opts = {}) => fetch(
    `${baseUrl}/api/sessions/${opts.sessionId || SESSION_ID}/source-preview?${new URLSearchParams(params)}`,
    { headers: opts.noCookie ? {} : { cookie } },
  );

  it('requires sign-in, same as every other /api route', async () => {
    const res = await preview({ url: SOURCE_URL }, { noCookie: true });

    assert.equal(res.status, 401);
    assert.equal(openUrlCalls.length, 0, 'never fetches a page for a signed-out request');
  });

  it('404s "Session not found" for a session the database does not have, without fetching anything', async () => {
    const res = await preview({ url: SOURCE_URL }, { sessionId: 999999 });

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Session not found' });
    assert.equal(openUrlCalls.length, 0);
  });

  it('400s a url that is not an absolute http(s) URL, and never fetches it', async () => {
    const res = await preview({ url: 'ftp://example-agency.org/guidance/' });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'A source preview needs an absolute http(s) URL.' });
    assert.equal(openUrlCalls.length, 0);
  });

  it('400s when no url is sent at all, without fetching anything', async () => {
    const res = await preview({});

    assert.equal(res.status, 400);
    assert.equal(openUrlCalls.length, 0);
  });

  it('403s a URL that appears nowhere in the session, and never fetches it', async () => {
    // An authenticated fetch proxy pointed at a third party is the thing this
    // gate exists to prevent, so the refusal has to be checked end to end.
    const res = await preview({ url: 'https://elsewhere.example.com/unrelated' });

    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'That URL does not appear in this session.' });
    assert.equal(openUrlCalls.length, 0);
  });

  it('returns the page title, published date, source details and matched sentence for a URL the session already has as a source', async () => {
    pages.set(SOURCE_URL, { title: 'Agency guidance page', published: '2026-03-01', text: PAGE_TEXT });

    const res = await preview({ url: SOURCE_URL, claim: CLAIM });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.url, SOURCE_URL);
    assert.equal(body.title, 'Agency guidance page');
    assert.equal(body.published, '2026-03-01');
    assert.equal(body.blocked, false);
    assert.equal(body.excerpt.match, MATCHED_SENTENCE);
    assert.equal(body.excerpt.quoted, false);
    assert.deepEqual(body.source, {
      n: 1, kind: 'cited', cited_by: [{ speaker: 'regulatory', mode: 'opening' }], first_message_id: 9,
    });
  });

  it('matches a source row written with a different scheme, www prefix or trailing slash, and fetches the URL that was asked for', async () => {
    const requested = 'http://example-agency.org/guidance';

    const res = await preview({ url: requested, claim: CLAIM });

    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.source.n, 1, 'the link is recognised as the sources row');
    assert.deepEqual(openUrlCalls, [requested]);
  });

  it('reads the session messages only when the URL is not already a known source', async () => {
    await preview({ url: SOURCE_URL, claim: CLAIM });

    assert.deepEqual(listMessagesCalls, [], 'a known source never loads the transcript');
  });

  it('reads the session messages to recognise a URL that is written in the prose but was never saved as a source', async () => {
    const url = 'https://msg-only.example.net/rule';

    const res = await preview({ url, claim: CLAIM });

    assert.equal(res.status, 200);
    assert.deepEqual(listMessagesCalls, [SESSION_ID]);
    assert.deepEqual(openUrlCalls, [url]);
    assert.equal((await res.json()).source, undefined, 'no sources row, so no source block');
  });

  it('returns the same preview from the cache on a second request, without fetching the page again', async () => {
    const url = 'https://cache-check.example.org/page';
    pages.set(url, { title: 'Cached page', text: PAGE_TEXT });

    const first = await (await preview({ url, claim: CLAIM })).json();
    const second = await (await preview({ url, claim: CLAIM })).json();

    assert.deepEqual(second, first);
    assert.deepEqual(openUrlCalls, [url], 'open_url ran once for two requests');
  });

  it('shows the fetch error as the note, and still answers 200, when the page cannot be fetched', async () => {
    const url = 'https://fail-fetch.example.org/down';
    openUrlFailures.set(url, new Error('getaddrinfo ENOTFOUND'));

    const res = await preview({ url, claim: CLAIM });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.blocked, true);
    assert.equal(body.excerpt, null);
    assert.equal(body.note, 'This page could not be fetched: getaddrinfo ENOTFOUND');
  });

  it('says the page had no readable text when open_url reports it blocked, such as a PDF', async () => {
    const url = 'https://pdf.example.org/report.pdf';
    pages.set(url, { blocked: true, title: '', published: null, text: 'This URL is a PDF; the tool cannot read PDFs.' });

    const res = await preview({ url, claim: CLAIM });

    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.blocked, true);
    assert.equal(body.excerpt, null);
    assert.equal(body.note, 'This page did not return readable text — a cookie wall, bot check or PDF answered instead.');
  });

  it('reports that no passage matches, with a note, when the page does not discuss the claim', async () => {
    const url = 'https://nothing.example.org/page';
    pages.set(url, { text: 'The weather in the north is mild this spring. Rain is expected on Tuesday. Gardens are blooming early.' });

    const res = await preview({ url, claim: CLAIM });

    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.excerpt, null);
    assert.equal(body.note, 'No passage on this page matches what the agent said closely enough to highlight.');
  });

  it('says there was nothing to match against when the link came without a sentence', async () => {
    const url = 'https://no-claim.example.org/page';

    const res = await preview({ url });

    const body = await res.json();
    assert.equal(body.excerpt, null);
    assert.equal(body.note, 'No sentence was sent with this link, so there is nothing to match against the page.');
  });

  it('marks a passage as quoted, with the page casing kept, when the claim quotes the page verbatim', async () => {
    const url = 'https://quoted.example.org/page';
    const claim = 'The guidance says “the agency issues a decision within 120 days” in its text.';

    const res = await preview({ url, claim });

    const body = await res.json();
    assert.equal(body.excerpt.quoted, true);
    assert.equal(body.excerpt.score, 1);
    assert.equal(body.excerpt.match, 'The agency issues a decision within 120 days');
  });

  it('answers 500 with the server error envelope when open_url resolves to nothing, instead of a partial preview', async () => {
    const url = 'https://empty-result.example.org/page';

    const res = await preview({ url, claim: CLAIM });

    const body = await res.json();
    assert.equal(res.status, 500);
    assert.match(body.error, /^Something went wrong on the server/);
  });
});
