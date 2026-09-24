'use strict';
// src/evidence.js is pure (no db, no network) — normText/normUrl, checkVerified,
// verifyText, sessionContext/turnContext, and the register renderer, tested
// directly against the shapes transcript.js and agents.js feed them.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const evidence = require('../src/evidence');
const {
  normText, normUrl, quoteOf, checkVerified, downgrade, classify, reasonOf,
  untaggedFigures, verifyText, countTags, sessionContext, turnContext,
  evidenceRegister, registerMarkdown, REASONS,
} = evidence;

describe('normText', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    assert.equal(normText('KRW 410 million,'), 'krw 410 million');
    assert.equal(normText('krw   410\nmillion'), 'krw 410 million');
  });

  it('is stable across case and spacing differences ("same words")', () => {
    assert.equal(normText('The FDA Approved It.'), normText('the fda approved it'));
  });

  it('keeps letters and digits of non-Latin scripts (Korean survives)', () => {
    const s = normText('한국 식약처 승인');
    assert.match(s, /[가-힣]/);
  });

  it('returns "" for null/undefined/empty', () => {
    assert.equal(normText(null), '');
    assert.equal(normText(undefined), '');
    assert.equal(normText(''), '');
  });
});

describe('normUrl', () => {
  it('drops scheme, a leading www., and a trailing slash', () => {
    assert.equal(normUrl('https://www.example.com/page/'), 'example.com/page');
    assert.equal(normUrl('http://example.com/page'), 'example.com/page');
  });

  it('drops the #fragment but keeps the query string', () => {
    assert.equal(normUrl('https://example.com/doc?id=42#section-2'), 'example.com/doc?id=42');
  });

  it('two spellings of the same page normalise to the same key', () => {
    assert.equal(normUrl('https://WWW.Example.com/Page/'), normUrl('http://example.com/Page'));
  });

  it('falls back to a trimmed lowercase string for an unparseable URL', () => {
    assert.equal(normUrl('  Not A URL  '), 'not a url');
  });
});

describe('quoteOf', () => {
  it('takes the LAST quoted passage, not a quoted source name earlier in the tag', () => {
    const tag = '[VERIFIED — "When Are Bridging Studies Mandatory" (ANMAT), https://x.com/a, 2026-01-01, "local Phase III data is required for all topical products"]';
    assert.equal(quoteOf(tag), 'local Phase III data is required for all topical products');
  });

  it('returns "" when the tag has no quoted passage', () => {
    assert.equal(quoteOf('[ESTIMATE — no source given]'), '');
  });

  it('reads typographic quotes and guillemets, not just straight ones', () => {
    assert.equal(quoteOf('[VERIFIED — x, https://x.com, 2026-01-01, "typed words here that are long enough"]'), 'typed words here that are long enough');
    assert.equal(quoteOf('[VERIFIED — x, https://x.com, 2026-01-01, «guillemet quoted words here»]'), 'guillemet quoted words here');
  });
});

const PAGE = { text: 'The Korean regulator KFDA requires local bridging data for topical GTN products before approval is granted.', title: 'KFDA Bridging Requirements' };
const URL = 'https://kfda.go.kr/notice/bridging';
const TAG = `[VERIFIED — KFDA, ${URL}, 2026-01-01, "requires local bridging data for topical GTN products"]`;

describe('checkVerified', () => {
  it('passes when the quote is found on a page opened this turn', () => {
    const r = checkVerified(TAG, { pages: new Map([[normUrl(URL), PAGE]]) });
    assert.equal(r.ok, true);
    assert.equal(r.url, URL);
  });

  it('fails with "no link" when the tag has no URL at all', () => {
    const r = checkVerified('[VERIFIED — KFDA, no url here, "requires local bridging data for topical GTN products"]', {});
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASONS.noLink);
  });

  it('fails with "no quote" when the tag has a URL but no quoted passage', () => {
    const r = checkVerified(`[VERIFIED — KFDA, ${URL}, 2026-01-01]`, { pages: new Map([[normUrl(URL), PAGE]]) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASONS.noQuote);
  });

  it('fails with "quote too short" for a quote under four words / twenty characters', () => {
    const r = checkVerified(`[VERIFIED — KFDA, ${URL}, 2026-01-01, "short quote"]`, { pages: new Map([[normUrl(URL), PAGE]]) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASONS.shortQuote);
  });

  it('twelve characters of Korean is long enough even though it is under four words', () => {
    const page = { text: '한국 식약처는 국내 임상시험 자료를 요구합니다', title: 'title' };
    const url = 'https://kfda.go.kr/kr';
    const tag = `[VERIFIED — KFDA, ${url}, 2026-01-01, "국내 임상시험 자료를 요구합니다"]`;
    const r = checkVerified(tag, { pages: new Map([[normUrl(url), page]]) });
    assert.equal(r.ok, true);
  });

  it('fails with "quote is only the page title" when the quote matches the title but not the body', () => {
    const page = { text: 'Body text with completely different words that never appear as a quote.', title: 'This Exact Quote Is Only The Title' };
    const url = 'https://x.com/a';
    const tag = `[VERIFIED — X, ${url}, 2026-01-01, "This Exact Quote Is Only The Title"]`;
    const r = checkVerified(tag, { pages: new Map([[normUrl(url), page]]) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASONS.titleQuote);
  });

  it('fails with "quote not found on the page" when the page was opened but says something else', () => {
    const page = { text: 'A page that never mentions Korea holding up a claim about Korean regulation at all.', title: 'Unrelated title' };
    const url = 'https://x.com/korea-claim';
    const tag = `[VERIFIED — X, ${url}, 2026-01-01, "requires local bridging data for topical GTN products"]`;
    const r = checkVerified(tag, { pages: new Map([[normUrl(url), page]]) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASONS.notOnPage);
  });

  it('fails with "page not opened this turn" when the URL was opened earlier in the session but not this turn', () => {
    const r = checkVerified(TAG, { opened: new Set([normUrl(URL)]) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASONS.notThisTurn);
  });

  it('fails with "page never opened" when the URL was never opened at all', () => {
    const r = checkVerified(TAG, {});
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASONS.neverOpened);
  });

  it('re-uses a quote verified earlier in the session for the same URL, without needing pages this turn', () => {
    const r = checkVerified(TAG, { verified: new Map([[normUrl(URL), [normText('requires local bridging data for topical GTN products')]]]) });
    assert.equal(r.ok, true);
  });

  it('re-uses a SHORTER quote than one verified earlier, as long as it is contained in it', () => {
    const longerVerified = normText('the regulator requires local bridging data for topical GTN products before approval');
    const shorterTag = `[VERIFIED — KFDA, ${URL}, 2026-01-01, "requires local bridging data for topical GTN products"]`;
    const r = checkVerified(shorterTag, { verified: new Map([[normUrl(URL), [longerVerified]]]) });
    assert.equal(r.ok, true);
  });

  it('rejects a LONGER quote than what was actually verified earlier for that URL', () => {
    const shorterVerified = normText('requires local bridging data');
    const longerTag = `[VERIFIED — KFDA, ${URL}, 2026-01-01, "requires local bridging data for topical GTN products before approval is granted here"]`;
    const r = checkVerified(longerTag, { verified: new Map([[normUrl(URL), [shorterVerified]]]) }); // no pages, no opened
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASONS.neverOpened);
  });

  it('an ellipsis quote is checked part by part; passes when every long-enough part is found on the page', () => {
    const page = { text: 'The first clause of the requirement appears here. Some filler text in between. The second clause about approval timing appears later.', title: 't' };
    const url = 'https://x.com/ellipsis';
    const tag = `[VERIFIED — X, ${url}, 2026-01-01, "first clause of the requirement … second clause about approval timing"]`;
    const r = checkVerified(tag, { pages: new Map([[normUrl(url), page]]) });
    assert.equal(r.ok, true);
  });

  it('an ellipsis quote fails when one of its parts is not on the page', () => {
    const page = { text: 'The first clause of the requirement appears here. Nothing else relevant.', title: 't' };
    const url = 'https://x.com/ellipsis2';
    const tag = `[VERIFIED — X, ${url}, 2026-01-01, "first clause of the requirement … a clause that is never on the page"]`;
    const r = checkVerified(tag, { pages: new Map([[normUrl(url), page]]) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASONS.notOnPage);
  });

  it('checks multiple URLs in the tag, succeeding on whichever one has the quote', () => {
    const otherUrl = 'https://other.example.com/nope';
    const tag = `[VERIFIED — X, ${otherUrl}, ${URL}, 2026-01-01, "requires local bridging data for topical GTN products"]`;
    const r = checkVerified(tag, { pages: new Map([[normUrl(URL), PAGE]]) });
    assert.equal(r.ok, true);
    assert.equal(r.url, URL);
  });

  it('a redirect: the page is keyed under the requested URL as well as the URL it landed on (agents.js stores both)', () => {
    const finalUrl = 'https://kfda.go.kr/final/landing';
    const pages = new Map();
    pages.set(normUrl(URL), PAGE);
    pages.set(normUrl(finalUrl), PAGE);
    const r = checkVerified(TAG, { pages });
    assert.equal(r.ok, true);
  });
});

describe('downgrade / classify / reasonOf', () => {
  it('downgrade rewrites a VERIFIED tag to an ESTIMATE carrying the reason, keeping the rest of the tag body', () => {
    const out = downgrade(TAG, REASONS.notOnPage);
    assert.match(out, /^\[ESTIMATE \(unverified, downgraded from VERIFIED: quote not found on the page\)/);
    assert.match(out, /KFDA/);
    assert.match(out, /requires local bridging data/);
  });

  it('classify identifies verified, downgraded (vs plain estimate), unknown and internal', () => {
    assert.equal(classify('[VERIFIED — x]'), 'verified');
    assert.equal(classify('[ESTIMATE — x]'), 'estimate');
    assert.equal(classify(downgrade(TAG, REASONS.notOnPage)), 'downgraded');
    assert.equal(classify('[UNKNOWN — needs local counsel]'), 'unknown');
    assert.equal(classify('[INTERNAL — pricing deck, not read by the panel]'), 'internal');
  });

  it('reasonOf reads the parenthetical reason from a downgraded tag, and falls back when absent', () => {
    assert.equal(reasonOf(downgrade(TAG, REASONS.notOnPage)), REASONS.notOnPage);
    assert.equal(reasonOf('[ESTIMATE (unverified, downgraded from VERIFIED) — x]'), 'page not opened');
    assert.equal(reasonOf('[ESTIMATE — plain estimate]'), null);
  });
});

describe('verifyText', () => {
  it('leaves a VERIFIED tag intact when it checks out', () => {
    const text = `Some claim. ${TAG}`;
    const out = verifyText(text, { pages: new Map([[normUrl(URL), PAGE]]) });
    assert.match(out.text, /\[VERIFIED —/);
    assert.equal(out.stats.verified, 1);
    assert.equal(out.stats.downgraded, 0);
    assert.deepEqual(out.verified, [{ url: URL, quote: 'requires local bridging data for topical GTN products' }]);
    assert.equal(out.failures.length, 0);
  });

  it('rewrites a failing VERIFIED tag to a downgraded ESTIMATE and records why', () => {
    const text = `Some claim. ${TAG}`;
    const out = verifyText(text, {}); // page never opened
    assert.doesNotMatch(out.text, /\[VERIFIED —/);
    assert.match(out.text, /\[ESTIMATE \(unverified, downgraded from VERIFIED: page never opened\)/);
    assert.equal(out.stats.downgraded, 1);
    assert.equal(out.stats.verified, 0);
    assert.equal(out.failures.length, 1);
    assert.equal(out.failures[0].reason, REASONS.neverOpened);
  });

  it('upper-cases a lowercase tag keyword so every later reader sees one spelling', () => {
    const out = verifyText('A claim. [unknown — needs local counsel]', {});
    assert.match(out.text, /\[UNKNOWN — needs local counsel\]/);
    assert.equal(out.stats.unknown, 1);
  });

  it('strips backticks a model wrapped a tag in, so it renders as a badge rather than code', () => {
    const out = verifyText('A claim. `[UNKNOWN — needs local counsel]`', {});
    assert.doesNotMatch(out.text, /`/);
    assert.match(out.text, /\[UNKNOWN — needs local counsel\]/);
  });

  it('counts untagged_figures for a numeric claim outside the Slides block with no tag on its line', () => {
    const out = verifyText('The market is worth USD 40 million this year.', {});
    assert.equal(out.stats.untagged_figures, 1);
  });

  it('does not count a figure that already carries a tag on the same line', () => {
    const out = verifyText(`The market is worth USD 40 million this year. ${TAG}`, { pages: new Map([[normUrl(URL), PAGE]]) });
    assert.equal(out.stats.untagged_figures, 0);
  });

  it('returns empty stats/text for empty input', () => {
    const out = verifyText('', {});
    assert.equal(out.text, '');
    assert.equal(out.stats.verified, 0);
    assert.deepEqual(out.verified, []);
    assert.deepEqual(out.failures, []);
  });
});

describe('countTags', () => {
  it('counts tags already stored (post verifyText) without re-checking them', () => {
    const stats = countTags(`${TAG} and [UNKNOWN — x] and ${downgrade(TAG, REASONS.notOnPage)}`);
    assert.equal(stats.verified, 1);
    assert.equal(stats.unknown, 1);
    assert.equal(stats.downgraded, 1);
  });
});

describe('sessionContext', () => {
  it('collects opened URLs, searched-result URLs, and verified quotes from agent messages, skipping user and error messages', () => {
    const messages = [
      { role: 'user', content_json: { trace: [{ type: 'open', url: 'https://should-be-skipped.example.com' }] } },
      {
        role: 'agent', error: 'boom',
        content_json: { trace: [{ type: 'open', url: 'https://also-skipped.example.com' }] },
      },
      {
        role: 'agent',
        content_json: {
          trace: [
            { type: 'search', results: [{ url: 'https://searched.example.com/a' }] },
            { type: 'open', url: 'https://opened.example.com/b', requested_url: 'https://opened.example.com/redirect-from' },
          ],
          evidence: { verified: [{ url: 'https://opened.example.com/b', quote: 'the words that were verified' }] },
        },
      },
    ];
    const ctx = sessionContext(messages);
    assert.equal(ctx.opened.has(normUrl('https://opened.example.com/b')), true);
    assert.equal(ctx.opened.has(normUrl('https://should-be-skipped.example.com')), false);
    assert.equal(ctx.opened.has(normUrl('https://also-skipped.example.com')), false);
    assert.equal(ctx.seen.has(normUrl('https://searched.example.com/a')), true);
    assert.equal(ctx.seen.has(normUrl('https://opened.example.com/redirect-from')), true);
    assert.deepEqual(ctx.verified.get(normUrl('https://opened.example.com/b')), [normText('the words that were verified')]);
  });

  it('parses a content_json stored as a JSON string, not just an object', () => {
    const messages = [{ role: 'agent', content_json: JSON.stringify({ trace: [{ type: 'search', results: [{ url: 'https://x.com/y' }] }] }) }];
    const ctx = sessionContext(messages);
    assert.equal(ctx.seen.has(normUrl('https://x.com/y')), true);
  });

  it('tolerates malformed JSON and missing content_json without throwing', () => {
    const messages = [{ role: 'agent', content_json: '{not json' }, { role: 'agent' }, null];
    assert.doesNotThrow(() => sessionContext(messages));
    const ctx = sessionContext(messages);
    assert.equal(ctx.opened.size, 0);
  });

  it('returns empty sets/map for an empty or undefined messages list', () => {
    const ctx = sessionContext([]);
    assert.equal(ctx.opened.size, 0);
    assert.equal(ctx.seen.size, 0);
    assert.equal(ctx.verified.size, 0);
    assert.doesNotThrow(() => sessionContext(undefined));
  });
});

describe('turnContext', () => {
  it('adds this turn\'s trace on top of the prior session context, and carries this turn\'s pages', () => {
    const session = { opened: new Set([normUrl('https://prior.example.com')]), seen: new Set(), verified: new Map([['k', ['v']]]) };
    const trace = [{ type: 'open', url: 'https://new.example.com' }];
    const pages = new Map([[normUrl('https://new.example.com'), PAGE]]);
    const ctx = turnContext(session, trace, pages);
    assert.equal(ctx.opened.has(normUrl('https://prior.example.com')), true);
    assert.equal(ctx.opened.has(normUrl('https://new.example.com')), true);
    assert.equal(ctx.verified.get('k')[0], 'v');
    assert.equal(ctx.pages.get(normUrl('https://new.example.com')), PAGE);
  });

  it('works with no prior session at all (first turn of a session)', () => {
    const ctx = turnContext(null, [{ type: 'search', results: [{ url: 'https://x.com' }] }], new Map());
    assert.equal(ctx.seen.has(normUrl('https://x.com')), true);
    assert.equal(ctx.verified.size, 0);
  });
});

describe('evidenceRegister / registerMarkdown', () => {
  const labelOf = (k) => (k === 'clinical' ? 'Luca (Clinical)' : k);
  const messages = [
    { role: 'agent', speaker: 'clinical', seq: 3, mode: 'opening', text: `Bridging data is required. ${TAG}\n\nAn internal figure applies: [INTERNAL — Pricing deck, not read by the panel]` },
    // The Moderator Assistant's own output is excluded from the register.
    { role: 'moderator', speaker: 'moderator', seq: 9, mode: 'decision', text: '[VERIFIED — x, https://x.com, 2026-01-01, "this should never appear in the register at all"]' },
  ];

  it('collects one row per tag, from agent messages only, and totals them by kind', () => {
    const reg = evidenceRegister(messages, labelOf);
    assert.equal(reg.rows.length, 2);
    assert.equal(reg.totals.verified, 1);
    assert.equal(reg.totals.internal, 1);
    assert.equal(reg.byAgent.get('Luca (Clinical)').verified, 1);
  });

  it('claimAround takes the line the tag sits on, with tags and citation markers stripped', () => {
    const reg = evidenceRegister(messages, labelOf);
    const verifiedRow = reg.rows.find((r) => r.kind === 'verified');
    assert.equal(verifiedRow.claim, 'Bridging data is required.');
  });

  it('registerMarkdown at "brief" depth includes the totals table only, no claim tables', () => {
    const reg = evidenceRegister(messages, labelOf);
    const md = registerMarkdown(reg, 'brief');
    assert.match(md, /1 VERIFIED/);
    assert.doesNotMatch(md, /### Verified claims/);
  });

  it('registerMarkdown at "standard" depth adds the verified-claims table', () => {
    const reg = evidenceRegister(messages, labelOf);
    const md = registerMarkdown(reg, 'standard');
    assert.match(md, /### Verified claims/);
    assert.match(md, /Bridging data is required\./);
    assert.doesNotMatch(md, /### UNKNOWN:/);
  });

  it('registerMarkdown at "full" depth also lists downgraded/unknown/internal/estimate sections', () => {
    const reg = evidenceRegister(messages, labelOf);
    const md = registerMarkdown(reg, 'full');
    assert.match(md, /### INTERNAL: rests on company material no agent could read/);
  });

  it('says "None." when there are no verified claims at all', () => {
    const reg = evidenceRegister([{ role: 'agent', speaker: 'clinical', seq: 1, mode: 'opening', text: '[UNKNOWN — needs local counsel]' }], labelOf);
    const md = registerMarkdown(reg, 'standard');
    assert.match(md, /None\. No claim in the transcript carries a quote the app could find on the page it cites\./);
  });
});

describe('untaggedFigures', () => {
  it('does not count figures inside the Slides block', () => {
    const text = 'Body with a stray figure of 40 million here.\n\n## Slides\n\n- Slide 1: 2026 launch, 40 million market';
    // The body line still counts (it's outside Slides); the Slides content must not add to it.
    assert.equal(untaggedFigures(text), 1);
  });

  it('ignores headings, table separators and lines that are all digits with no words', () => {
    const text = '# Heading 2026\n|---|---|\n2026';
    assert.equal(untaggedFigures(text), 0);
  });
});
