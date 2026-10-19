'use strict';
// src/source-preview.js on its own: the gate that decides which URLs may be
// fetched (only URLs the session already has, as a source row or as a whole
// URL in an agent's or the moderator's text), sameUrl, the failure cache and
// the wording of the note. The page fetch is a stub passed in as fetchPage and
// every test gets its own cache, so no network is used and no test depends on
// another. The route-level behaviour is in app-source-preview-route.test.js.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildPreview, sameUrl, makeCache } = require('../src/source-preview');

const PAGE_TEXT = 'The agency issues a decision within 120 days of a complete dossier. Fees are 45,000 euros.';
const CLAIM = 'The agency issues a decision within 120 days of a complete dossier.';
const NOT_IN_SESSION = { error: 'That URL does not appear in this session.' };

// A fetchPage stub that returns a readable page and records every URL asked for.
function readablePage() {
  const calls = [];
  const fetchPage = async (url) => {
    calls.push(url);
    return { url, status: 200, title: 'Guidance', published: null, blocked: false, text: PAGE_TEXT };
  };
  return { fetchPage, calls };
}

describe('buildPreview gate: which URLs the session mentions', () => {
  it('refuses a URL that only a user-role message mentions, and never fetches it', async () => {
    const { fetchPage, calls } = readablePage();
    const messages = [{ role: 'user', text: 'Please check https://gate.example.org/user-only' }];

    const res = await buildPreview({ url: 'https://gate.example.org/user-only', claim: CLAIM, sources: [], messages, fetchPage, cache: makeCache() });

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, NOT_IN_SESSION);
    assert.deepEqual(calls, []);
  });

  it('refuses a URL that only a system-role message mentions, and never fetches it', async () => {
    const { fetchPage, calls } = readablePage();
    const messages = [{ role: 'system', text: 'Session note: https://gate.example.org/system-only' }];

    const res = await buildPreview({ url: 'https://gate.example.org/system-only', claim: CLAIM, sources: [], messages, fetchPage, cache: makeCache() });

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, NOT_IN_SESSION);
    assert.deepEqual(calls, []);
  });

  it('allows a URL that an agent-role message mentions as a whole URL', async () => {
    const { fetchPage, calls } = readablePage();
    const messages = [{ role: 'agent', text: 'The rule is at https://gate.example.org/agent-rule and sets the clock.' }];

    const res = await buildPreview({ url: 'https://gate.example.org/agent-rule', claim: CLAIM, sources: [], messages, fetchPage, cache: makeCache() });

    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['https://gate.example.org/agent-rule']);
  });

  it('allows a URL that a moderator-role message mentions as a whole URL', async () => {
    const { fetchPage, calls } = readablePage();
    const messages = [{ role: 'moderator', text: 'Decision cites https://gate.example.org/moderator-rule as the basis.' }];

    const res = await buildPreview({ url: 'https://gate.example.org/moderator-rule', claim: CLAIM, sources: [], messages, fetchPage, cache: makeCache() });

    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['https://gate.example.org/moderator-rule']);
  });

  it('refuses the host root when only a deeper URL on that host was written', async () => {
    const { fetchPage, calls } = readablePage();
    const messages = [{ role: 'agent', text: 'See https://gate.example.org/path for the fee table.' }];

    const res = await buildPreview({ url: 'https://gate.example.org/', claim: CLAIM, sources: [], messages, fetchPage, cache: makeCache() });

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, NOT_IN_SESSION);
    assert.deepEqual(calls, []);
  });

  it('still matches a bare URL that is followed by a full stop in the prose', async () => {
    const { fetchPage, calls } = readablePage();
    const messages = [{ role: 'agent', text: 'The fees are set out at https://gate.example.org/fees.' }];

    const res = await buildPreview({ url: 'https://gate.example.org/fees', claim: CLAIM, sources: [], messages, fetchPage, cache: makeCache() });

    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['https://gate.example.org/fees']);
  });

  it('still matches a URL written in parentheses, without the closing bracket', async () => {
    const { fetchPage, calls } = readablePage();
    const messages = [{ role: 'agent', text: 'The schedule (https://gate.example.org/schedule) applies.' }];

    const res = await buildPreview({ url: 'https://gate.example.org/schedule', claim: CLAIM, sources: [], messages, fetchPage, cache: makeCache() });

    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['https://gate.example.org/schedule']);
  });

  it('allows the URL when a user wrote it and an agent also wrote it', async () => {
    const { fetchPage, calls } = readablePage();
    const messages = [
      { role: 'user', text: 'What about https://gate.example.org/both?' },
      { role: 'agent', text: 'It is https://gate.example.org/both, per the notice.' },
    ];

    const res = await buildPreview({ url: 'https://gate.example.org/both', claim: CLAIM, sources: [], messages, fetchPage, cache: makeCache() });

    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['https://gate.example.org/both']);
  });

  it('answers 400 for a missing url and never fetches anything', async () => {
    const { fetchPage, calls } = readablePage();

    const res = await buildPreview({ url: undefined, claim: CLAIM, sources: [], messages: [], fetchPage, cache: makeCache() });

    assert.equal(res.status, 400);
    assert.deepEqual(calls, []);
  });

  it('does not change the sources or messages it is given', async () => {
    const { fetchPage } = readablePage();
    const sources = [{ n: 1, url: 'https://gate.example.org/kept', title: 'Kept', kind: 'cited', cited_by: [{ speaker: 'regulatory' }], first_message_id: 3 }];
    const messages = [{ role: 'agent', text: 'See https://gate.example.org/kept.' }];
    const before = structuredClone({ sources, messages });

    await buildPreview({ url: 'https://gate.example.org/kept', claim: CLAIM, sources, messages, fetchPage, cache: makeCache() });

    assert.deepEqual({ sources, messages }, before);
  });
});

describe('sameUrl', () => {
  it('matches the same URL written with www, a trailing slash, and http instead of https', () => {
    assert.equal(sameUrl('https://www.x.com/a/', 'http://x.com/a'), true);
  });

  it('treats an explicit default port as the same URL as no port', () => {
    assert.equal(sameUrl('https://x.com:443/a', 'https://x.com/a'), true);
  });

  it('treats a different port as a different URL, even on the same host and path', () => {
    assert.equal(sameUrl('http://x.com:8080/a', 'https://x.com/a'), false);
  });

  it('treats paths that differ only in case as different URLs', () => {
    assert.equal(sameUrl('https://x.com/A', 'https://x.com/a'), false);
  });

  it('treats different query strings as different URLs', () => {
    assert.equal(sameUrl('https://x.com/a?b=1', 'https://x.com/a'), false);
  });

  it('matches nothing when a value is not a URL at all', () => {
    assert.equal(sameUrl('not a url', 'not a url'), false);
    assert.equal(sameUrl(undefined, undefined), false);
  });
});

describe('buildPreview failure cache', () => {
  it('does not keep a fetch that threw, so the retry fetches again and gets the page', async () => {
    const cache = makeCache();
    const calls = [];
    const fetchPage = async (url) => {
      calls.push(url);
      if (calls.length === 1) throw new Error('socket hang up');
      return { url, status: 200, title: 'Guidance', published: null, blocked: false, text: PAGE_TEXT };
    };
    const args = { url: 'https://cache-fail.example.org/page', claim: CLAIM, sources: [], messages: [{ role: 'agent', text: 'See https://cache-fail.example.org/page' }], fetchPage, cache };

    const first = await buildPreview(args);
    const second = await buildPreview(args);

    assert.equal(first.body.blocked, true);
    assert.equal(second.body.blocked, false);
    assert.match(second.body.excerpt.match, /120 days/);
    assert.equal(calls.length, 2, 'the failed fetch was not replayed from the cache');
  });

  it('keeps a successful page in the cache, so a second request does not fetch again', async () => {
    const cache = makeCache();
    const { fetchPage, calls } = readablePage();
    const args = { url: 'https://cache-ok.example.org/page', claim: CLAIM, sources: [], messages: [{ role: 'agent', text: 'See https://cache-ok.example.org/page' }], fetchPage, cache };

    const first = await buildPreview(args);
    const second = await buildPreview(args);

    assert.deepEqual(second, first);
    assert.deepEqual(calls, ['https://cache-ok.example.org/page']);
  });

  it('does not keep a blocked page either, so a later request reads the real page', async () => {
    const cache = makeCache();
    const calls = [];
    const fetchPage = async (url) => {
      calls.push(url);
      if (calls.length === 1) return { url, status: 200, title: '', published: null, blocked: true, text: 'Checking your browser before accessing the page.' };
      return { url, status: 200, title: 'Guidance', published: null, blocked: false, text: PAGE_TEXT };
    };
    const args = { url: 'https://cache-bot.example.org/page', claim: CLAIM, sources: [], messages: [{ role: 'agent', text: 'See https://cache-bot.example.org/page' }], fetchPage, cache };

    await buildPreview(args);
    const second = await buildPreview(args);

    assert.equal(second.body.blocked, false);
    assert.equal(calls.length, 2);
  });
});

describe('buildPreview note for a blocked page', () => {
  it('says HTTP 404 for a blocked page that answered 404 with no error, not the cookie-wall text', async () => {
    const fetchPage = async (url) => ({ url, status: 404, title: '', published: null, blocked: true, text: 'HTTP 404 when fetching this page. You have NOT read it; do not cite it.' });
    const messages = [{ role: 'agent', text: 'See https://note-404.example.org/gone' }];

    const res = await buildPreview({ url: 'https://note-404.example.org/gone', claim: CLAIM, sources: [], messages, fetchPage, cache: makeCache() });

    assert.equal(res.status, 200);
    assert.equal(res.body.blocked, true);
    assert.equal(res.body.note, 'The page answered with HTTP 404, so there is nothing to read.');
  });

  it('says HTTP 429 for a blocked page that answered 429', async () => {
    const fetchPage = async (url) => ({ url, status: 429, title: '', published: null, blocked: true, text: 'HTTP 429 when fetching this page.' });
    const messages = [{ role: 'agent', text: 'See https://note-429.example.org/busy' }];

    const res = await buildPreview({ url: 'https://note-429.example.org/busy', claim: CLAIM, sources: [], messages, fetchPage, cache: makeCache() });

    assert.equal(res.body.note, 'The page answered with HTTP 429, so there is nothing to read.');
  });

  it('keeps the cookie-wall text for a blocked page that answered 200', async () => {
    const fetchPage = async (url) => ({ url, status: 200, title: '', published: null, blocked: true, text: 'Cookies must be enabled to continue.' });
    const messages = [{ role: 'agent', text: 'See https://note-200.example.org/wall' }];

    const res = await buildPreview({ url: 'https://note-200.example.org/wall', claim: CLAIM, sources: [], messages, fetchPage, cache: makeCache() });

    assert.equal(res.body.note, 'This page did not return readable text — a cookie wall, bot check or PDF answered instead.');
  });
});
