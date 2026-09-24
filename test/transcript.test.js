'use strict';
// src/transcript.js assembleText: checks VERIFIED tags (src/evidence.js),
// registers every searched/opened/cited URL as a session source (kind
// 'searched' / 'cited' / 'unverified'), numbers citations [n], and de-dupes a
// tag's own pre-existing [n] markers instead of doubling them. src/db.js is
// stubbed in-process (no real Postgres) — same require.cache-swap technique
// test/helpers/start-app.js uses, without booting the whole app.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const dbPath = require.resolve('../src/db');
let sources, upsertCalls;

function fakeUpsertSource(sessionId, { url, title, kind, messageId, speaker }) {
  upsertCalls.push({ sessionId, url, title, kind, messageId, speaker });
  const existing = sources.find((s) => s.url === url);
  if (existing) {
    if (kind === 'cited' || existing.kind === 'unverified' && kind === 'searched') existing.kind = 'cited';
    return existing.n;
  }
  const n = sources.length + 1;
  sources.push({ n, url, title, kind });
  return n;
}

require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { upsertSource: (...args) => fakeUpsertSource(...args) },
};

const { assembleText } = require('../src/transcript');

beforeEach(() => { sources = []; upsertCalls = []; });

const PAGE = { text: 'The KFDA requires local bridging data for topical GTN products before approval is granted.', title: 'KFDA notice' };
const URL = 'https://kfda.go.kr/notice/bridging';

describe('assembleText — VERIFIED tag checking', () => {
  it('leaves a VERIFIED tag intact and numbers its URL as a citation when the page was opened this turn', async () => {
    const text = `Local data is required. [VERIFIED — KFDA, ${URL}, 2026-01-01, "requires local bridging data for topical GTN products"]`;
    const trace = [{ type: 'open', url: URL, title: 'KFDA notice' }];
    const ctx = { pages: new Map([[require('../src/evidence').normUrl(URL), PAGE]]) };
    const out = await assembleText(1, 100, 'clinical', text, trace, ctx);
    assert.match(out.text, /\[VERIFIED —/);
    assert.match(out.text, /\[1\]/);
    assert.equal(out.evidence.counts.verified, 1);
    assert.deepEqual(out.evidence.verified, [{ url: URL, quote: 'requires local bridging data for topical GTN products' }]);
    assert.equal(out.evidence.failures.length, 0);
  });

  it('downgrades a VERIFIED tag whose page was never opened, and records why in evidence.failures', async () => {
    const text = `Local data is required. [VERIFIED — KFDA, ${URL}, 2026-01-01, "requires local bridging data for topical GTN products"]`;
    const out = await assembleText(1, 100, 'clinical', text, [], {});
    assert.match(out.text, /\[ESTIMATE \(unverified, downgraded from VERIFIED: page never opened\)/);
    assert.equal(out.evidence.counts.downgraded, 1);
    assert.deepEqual(out.evidence.failures, ['page never opened']);
  });
});

describe('assembleText — source kinds', () => {
  it('registers a search result URL as "searched"', async () => {
    const trace = [{ type: 'search', results: [{ url: 'https://a.example.com/x', title: 'A' }] }];
    await assembleText(1, 100, 'clinical', 'No tags here.', trace, {});
    assert.equal(sources.find((s) => s.url === 'https://a.example.com/x').kind, 'searched');
  });

  it('registers an opened URL as "cited"', async () => {
    const trace = [{ type: 'open', url: 'https://a.example.com/x', title: 'A' }];
    await assembleText(1, 100, 'clinical', 'No tags here.', trace, {});
    assert.equal(sources.find((s) => s.url === 'https://a.example.com/x').kind, 'cited');
  });

  it('registers a bare URL in the text that was never searched or opened as "unverified"', async () => {
    const text = 'See https://invented.example.com/source for details.';
    const out = await assembleText(1, 100, 'clinical', text, [], {});
    assert.equal(sources.find((s) => s.url === 'https://invented.example.com/source').kind, 'unverified');
    assert.match(out.text, /https:\/\/invented\.example\.com\/source \[1\]/);
  });

  it('a cited URL that was ALSO seen this turn (search or open) is registered as "cited", not "unverified"', async () => {
    const trace = [{ type: 'search', results: [{ url: 'https://a.example.com/y', title: 'Y' }] }];
    const text = 'As before, see https://a.example.com/y for the numbers.';
    await assembleText(1, 100, 'clinical', text, trace, {});
    // Only one row: search registered it 'searched', the bare-URL citation
    // then upserts it again as 'cited' — the fake db mirrors the real
    // upsertSource's move-only-toward-'cited' merge.
    const row = sources.find((s) => s.url === 'https://a.example.com/y');
    assert.equal(row.kind, 'cited');
  });
});

describe('assembleText — citation numbering and marker de-dup', () => {
  it('appends [n] after a tag\'s closing bracket for each unique URL inside it', async () => {
    const text = `Claim. [ESTIMATE — no page read, ${URL}]`;
    const out = await assembleText(1, 100, 'clinical', text, [], {});
    assert.match(out.text, /\[ESTIMATE — no page read, https:\/\/kfda\.go\.kr\/notice\/bridging\] \[1\]/);
  });

  it('does not double an existing "[n]" marker already following a tag copied from the transcript', async () => {
    const text = `Claim. [ESTIMATE — no page read, ${URL}] [7]`;
    const out = await assembleText(1, 100, 'clinical', text, [], {});
    // Rebuilt from scratch (the tag has a URL, so its markers are always
    // recomputed) — the stale "[7]" is swallowed, not kept alongside a new one.
    const matches = out.text.match(/\[\d+\]/g);
    assert.deepEqual(matches, ['[1]']);
  });

  it('does not add a marker for a URL that is a Markdown link target ("[text](url)")', async () => {
    const text = `See [the notice](${URL}) for details.`;
    const out = await assembleText(1, 100, 'clinical', text, [], {});
    assert.doesNotMatch(out.text, /\[1\]/);
  });

  it('leaves a tag with no URLs untouched, with nothing appended after it', async () => {
    const text = 'Claim. [UNKNOWN — needs local counsel]';
    const out = await assembleText(1, 100, 'clinical', text, [], {});
    assert.equal(out.text.trim(), 'Claim. [UNKNOWN — needs local counsel]');
  });
});

describe('assembleText — register: false (meeting minutes)', () => {
  it('checks tags but touches no sources at all', async () => {
    const text = `Claim. [VERIFIED — KFDA, ${URL}, 2026-01-01, "requires local bridging data for topical GTN products"]`;
    const out = await assembleText(1, null, 'moderator', text, [], {}, { register: false });
    assert.match(out.text, /\[ESTIMATE \(unverified, downgraded from VERIFIED/);
    assert.equal(upsertCalls.length, 0);
    assert.equal(sources.length, 0);
  });
});
