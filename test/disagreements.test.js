'use strict';
// src/disagreements.js is pure — no db, no network. Covers the ⚠ block regex
// tolerance (missing "DISAGREEMENT" word, bold markers, a dash instead of a
// colon, PARTIALLY RESOLVED), the topic/status extraction, and the two things
// the app writes from the parsed log rather than trusting a model: the
// open-disagreements section in meeting minutes, and dropping a model-written
// section with the same name.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { disagreementTopic, disagreementStatus, parseDisagreements, openDisagreementsMarkdown, dropSection } = require('../src/disagreements');

describe('parseDisagreements', () => {
  it('parses a well-formed block: emoji, word DISAGREEMENT, colon, Status line', () => {
    const text = '⚠️ DISAGREEMENT: Bridging data requirement\n\nPosition A: Ruth says local data is mandatory.\n\nPosition B: Luca says a waiver is possible.\n\nStatus: UNRESOLVED — needs ANMAT confirmation.';
    const out = parseDisagreements(text);
    assert.equal(out.length, 1);
    assert.equal(out[0].topic, 'Bridging data requirement');
    assert.equal(out[0].status, 'unresolved');
  });

  it('tolerates a missing emoji variation selector, missing word DISAGREEMENT, and a dash instead of a colon', () => {
    const text = '⚠ Pricing strategy\n\nStatus — RESOLVED: agreed on tiered pricing.';
    const out = parseDisagreements(text);
    assert.equal(out.length, 1);
    assert.equal(out[0].topic, 'Pricing strategy');
    assert.equal(out[0].status, 'resolved');
  });

  it('tolerates bold markers around "Status" and the colon', () => {
    const text = '⚠️ DISAGREEMENT: Reimbursement timeline\n\n**Status**: RESOLVED — PAMI confirmed 12 months.';
    const out = parseDisagreements(text);
    assert.equal(out[0].status, 'resolved');
  });

  it('PARTIALLY RESOLVED counts as unresolved, not resolved', () => {
    const text = '⚠️ DISAGREEMENT: Trial design\n\nStatus: PARTIALLY RESOLVED — endpoint agreed, sample size still open.';
    const out = parseDisagreements(text);
    assert.equal(out[0].status, 'unresolved');
  });

  it('finds multiple blocks in one message, in order', () => {
    const text = [
      '⚠️ DISAGREEMENT: First topic',
      '',
      'Status: UNRESOLVED — open.',
      '',
      'Some other prose in between.',
      '',
      '⚠️ DISAGREEMENT: Second topic',
      '',
      'Status: RESOLVED — closed.',
    ].join('\n');
    const out = parseDisagreements(text);
    assert.equal(out.length, 2);
    assert.equal(out[0].topic, 'First topic');
    assert.equal(out[1].topic, 'Second topic');
    assert.equal(out[1].status, 'resolved');
  });

  it('returns [] for text with no ⚠ at all', () => {
    assert.deepEqual(parseDisagreements('Just a normal agent turn, no disputes here.'), []);
  });

  it('returns [] for empty/undefined text', () => {
    assert.deepEqual(parseDisagreements(''), []);
    assert.deepEqual(parseDisagreements(undefined), []);
  });

  it('does not let a stray ⚠ swallow the whole rest of the transcript: caps at 1500 characters before giving up on finding Status', () => {
    const filler = 'x'.repeat(2000);
    const text = `⚠️ DISAGREEMENT: Runaway block\n\n${filler}\n\nStatus: UNRESOLVED — too late, out of range.`;
    const out = parseDisagreements(text);
    assert.equal(out.length, 0, 'the real Status line sits beyond the 1500-char window, so no block is matched');
  });
});

describe('disagreementTopic', () => {
  it('strips the emoji, the word DISAGREEMENT, and separators', () => {
    assert.equal(disagreementTopic('⚠️ DISAGREEMENT: Bridging data requirement'), 'Bridging data requirement');
  });

  it('strips a trailing "(Status: …)" and anything from "Position A" onward when a block is collapsed onto one line', () => {
    assert.equal(disagreementTopic('⚠️ DISAGREEMENT — Pricing (Status: unresolved) Position A: Ruth says X'), 'Pricing');
  });

  it('strips bold/underscore emphasis and brackets', () => {
    assert.equal(disagreementTopic('⚠️ **DISAGREEMENT**: [Trial design]'), 'Trial design');
  });

  it('falls back to "untitled" when nothing is left after stripping', () => {
    assert.equal(disagreementTopic('⚠️ DISAGREEMENT:'), 'untitled');
  });

  it('returns "untitled" for empty/undefined input', () => {
    assert.equal(disagreementTopic(''), 'untitled');
    assert.equal(disagreementTopic(undefined), 'untitled');
  });
});

describe('disagreementStatus', () => {
  it('is "resolved" only when the Status line starts with RESOLVED and says nothing else open', () => {
    assert.equal(disagreementStatus('Status: RESOLVED — agreed.'), 'resolved');
  });

  it('is "unresolved" for UNRESOLVED', () => {
    assert.equal(disagreementStatus('Status: UNRESOLVED — still open.'), 'unresolved');
  });

  it('is "unresolved" for "RESOLVED (how) / UNRESOLVED" copied verbatim from the template', () => {
    assert.equal(disagreementStatus('Status: RESOLVED (how) / UNRESOLVED'), 'unresolved');
  });

  it('is "unresolved" when there is no Status line at all', () => {
    assert.equal(disagreementStatus('No status line here.'), 'unresolved');
  });
});

describe('openDisagreementsMarkdown', () => {
  it('lists only unresolved disagreements by number and topic', () => {
    const disagreements = [
      { n: 1, topic: 'Bridging data', status: 'resolved' },
      { n: 2, topic: 'Pricing tier', status: 'unresolved' },
      { n: 3, topic: 'Trial design', status: 'unresolved' },
    ];
    const md = openDisagreementsMarkdown(disagreements);
    assert.match(md, /## Open disagreements/);
    assert.doesNotMatch(md, /#1 Bridging data/);
    assert.match(md, /- #2 Pricing tier — UNRESOLVED/);
    assert.match(md, /- #3 Trial design — UNRESOLVED/);
  });

  it('says "None." when every disagreement is resolved, or there are none', () => {
    assert.match(openDisagreementsMarkdown([{ n: 1, topic: 'x', status: 'resolved' }]), /## Open disagreements\n\nNone\./);
    assert.match(openDisagreementsMarkdown([]), /## Open disagreements\n\nNone\./);
    assert.match(openDisagreementsMarkdown(undefined), /## Open disagreements\n\nNone\./);
  });
});

describe('dropSection', () => {
  it('drops a heading section by name, down to the next heading of the same or a higher level', () => {
    const text = [
      '# Minutes',
      '',
      '## Open disagreements',
      '',
      '- A model-written line that should be replaced by the app\'s own log.',
      '',
      '## Next steps',
      '',
      '- Keep this.',
    ].join('\n');
    const out = dropSection(text, /^open disagreements\b/i);
    assert.doesNotMatch(out, /model-written line/);
    assert.match(out, /## Next steps/);
    assert.match(out, /Keep this\./);
  });

  it('drops a bold "**Open disagreements:**" line with no heading marker, down to the next heading', () => {
    const text = [
      'Intro line.',
      '',
      '**Open disagreements:**',
      '- Should be dropped.',
      '',
      '## Next steps',
      '- Keep this.',
    ].join('\n');
    const out = dropSection(text, /^open disagreements\b/i);
    assert.doesNotMatch(out, /Should be dropped/);
    assert.match(out, /Keep this\./);
    assert.match(out, /Intro line\./);
  });

  it('leaves the text unchanged when the named section is not present', () => {
    const text = '# Minutes\n\n## Next steps\n- Do the thing.';
    assert.equal(dropSection(text, /^open disagreements\b/i), text);
  });

  it('drops the section to the end of the text when it is the last section', () => {
    const text = '# Minutes\n\n## Open disagreements\n- dropped.';
    const out = dropSection(text, /^open disagreements\b/i);
    assert.doesNotMatch(out, /dropped/);
  });
});
