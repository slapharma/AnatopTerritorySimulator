'use strict';
// src/questions.js is pure — no db, no network — so it's tested directly
// against the agents roster shape prompts.js builds from prompts/agents/index.json
// (key/name/short/function/label per agent).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseQuestions, addresseeKeys, parseQuestionStatus, parseAnsweredCheck } = require('../src/questions');

const AGENTS = {
  regulatory: { key: 'regulatory', name: 'Ruth', short: 'Ruth', function: 'Regulatory', label: 'Ruth (Regulatory)' },
  clinical: { key: 'clinical', name: 'Luca', short: 'Luca', function: 'Clinical', label: 'Luca (Clinical)' },
  commercial: { key: 'commercial', name: 'Charlie', short: 'Charlie', function: 'Commercial', label: 'Charlie (Commercial)' },
};

describe('parseQuestions', () => {
  it('reads a plain "Questions for X:" heading with numbered items', () => {
    const text = [
      'Some baseline discussion here.',
      '',
      'Questions for Luca:',
      '1. Will ANMAT require local bridging data for a topical GTN product?',
      '2. Is the topical route already precedented in Argentina?',
    ].join('\n');

    const out = parseQuestions(text, AGENTS, 'regulatory');

    assert.deepEqual(out, [
      { addressees: ['clinical'], n: 1, text: 'Will ANMAT require local bridging data for a topical GTN product?' },
      { addressees: ['clinical'], n: 2, text: 'Is the topical route already precedented in Argentina?' },
    ]);
  });

  it('reads a bold heading with a bulleted item ("**Questions for the Moderator**")', () => {
    const text = [
      '**Questions for the Moderator**',
      '- Does the dossier include ICH stability data?',
    ].join('\n');

    const out = parseQuestions(text, AGENTS, 'regulatory');

    assert.deepEqual(out, [{ addressees: ['moderator'], n: 1, text: 'Does the dossier include ICH stability data?' }]);
  });

  it('reads a "### Questions for X and Y" markdown heading with ")"-numbered items', () => {
    const text = [
      '### Questions for Luca and Charlie',
      '1) What is the PAMI reimbursement timeline?',
      '2) Who owns pricing sign-off?',
    ].join('\n');

    const out = parseQuestions(text, AGENTS, 'regulatory');

    assert.deepEqual(out, [
      { addressees: ['clinical', 'commercial'], n: 1, text: 'What is the PAMI reimbursement timeline?' },
      { addressees: ['clinical', 'commercial'], n: 2, text: 'Who owns pricing sign-off?' },
    ]);
  });

  it('reads "•" bulleted items', () => {
    const text = ['Questions for Luca:', '• What is the enrolment timeline?'].join('\n');

    const out = parseQuestions(text, AGENTS, 'regulatory');

    assert.deepEqual(out, [{ addressees: ['clinical'], n: 1, text: 'What is the enrolment timeline?' }]);
  });

  it('joins a wrapped continuation line onto the item above it', () => {
    const text = [
      'Questions for Luca:',
      '1. This question is long and',
      '   wraps onto a second physical line.',
    ].join('\n');

    const out = parseQuestions(text, AGENTS, 'regulatory');

    assert.deepEqual(out, [{ addressees: ['clinical'], n: 1, text: 'This question is long and wraps onto a second physical line.' }]);
  });

  it('treats a single blank line between items as a separator, not a merge', () => {
    const text = [
      'Questions for Luca:',
      '1. First question?',
      '',
      '2. Second question?',
    ].join('\n');

    const out = parseQuestions(text, AGENTS, 'regulatory');

    assert.deepEqual(out, [
      { addressees: ['clinical'], n: 1, text: 'First question?' },
      { addressees: ['clinical'], n: 2, text: 'Second question?' },
    ]);
  });

  it('ends the block at a following heading, including "## Summary slides"', () => {
    const text = [
      'Questions for Luca:',
      '1. Q1?',
      '2. Q2?',
      '',
      '## Summary slides',
      '- Not a question, just a slide bullet.',
    ].join('\n');

    const out = parseQuestions(text, AGENTS, 'regulatory');

    assert.deepEqual(out, [
      { addressees: ['clinical'], n: 1, text: 'Q1?' },
      { addressees: ['clinical'], n: 2, text: 'Q2?' },
    ]);
  });

  it('numbers questions across multiple blocks in one message, starting a new block at the next heading', () => {
    const text = [
      'Questions for Luca:',
      '1. Q to Luca?',
      '',
      'Questions for Charlie:',
      '1. Q to Charlie?',
    ].join('\n');

    const out = parseQuestions(text, AGENTS, 'regulatory');

    assert.deepEqual(out, [
      { addressees: ['clinical'], n: 1, text: 'Q to Luca?' },
      { addressees: ['commercial'], n: 2, text: 'Q to Charlie?' },
    ]);
  });

  it('excludes the asker from a multi-addressee heading ("Ruth and Luca") asked by Ruth', () => {
    const text = ['Questions for Ruth and Luca:', '1. Can we proceed without local data?'].join('\n');

    const out = parseQuestions(text, AGENTS, 'regulatory');

    assert.deepEqual(out, [{ addressees: ['clinical'], n: 1, text: 'Can we proceed without local data?' }]);
  });

  it('reads a "Name (Function)" addressee, e.g. "Questions for Luca (Clinical):"', () => {
    const text = ['Questions for Luca (Clinical):', '1. Q?'].join('\n');

    const out = parseQuestions(text, AGENTS, 'regulatory');

    assert.deepEqual(out, [{ addressees: ['clinical'], n: 1, text: 'Q?' }]);
  });

  it('maps "Moderator" and "the Moderator" both to the moderator key', () => {
    const plain = parseQuestions(['Questions for Moderator:', '1. Q?'].join('\n'), AGENTS, 'regulatory');
    const withThe = parseQuestions(['Questions for the Moderator:', '1. Q?'].join('\n'), AGENTS, 'regulatory');

    assert.deepEqual(plain, [{ addressees: ['moderator'], n: 1, text: 'Q?' }]);
    assert.deepEqual(withThe, [{ addressees: ['moderator'], n: 1, text: 'Q?' }]);
  });

  it('skips a whole block, without consuming numbering, when the addressee is not recognised', () => {
    const text = [
      'Questions for Dr. Smith:',
      '1. Unrecognised addressee question?',
      '',
      'Questions for Luca:',
      '1. Recognised question?',
    ].join('\n');

    const out = parseQuestions(text, AGENTS, 'regulatory');

    // Only the Luca block survives, and it still starts numbering at 1 — the
    // skipped block was never added to `out`, so never consumed an n.
    assert.deepEqual(out, [{ addressees: ['clinical'], n: 1, text: 'Recognised question?' }]);
  });

  it('returns [] for empty or whitespace-only text', () => {
    assert.deepEqual(parseQuestions('', AGENTS, 'regulatory'), []);
    assert.deepEqual(parseQuestions('   \n  \n', AGENTS, 'regulatory'), []);
  });

  it('returns [] for text with no "Questions for" heading at all', () => {
    assert.deepEqual(parseQuestions('Just a normal response with no questions block.', AGENTS, 'regulatory'), []);
  });
});

describe('addresseeKeys', () => {
  it('splits "Ruth and Luca" into both keys', () => {
    assert.deepEqual(addresseeKeys('Ruth and Luca', AGENTS), ['regulatory', 'clinical']);
  });

  it('splits on a comma and a slash', () => {
    assert.deepEqual(addresseeKeys('Ruth, Luca', AGENTS), ['regulatory', 'clinical']);
    assert.deepEqual(addresseeKeys('Ruth/Luca', AGENTS), ['regulatory', 'clinical']);
  });

  it('splits on "&"', () => {
    assert.deepEqual(addresseeKeys('Ruth & Luca', AGENTS), ['regulatory', 'clinical']);
  });

  it('expands "all"/"everyone"/"the panel" to every agent key', () => {
    assert.deepEqual(addresseeKeys('all', AGENTS), ['regulatory', 'clinical', 'commercial']);
    assert.deepEqual(addresseeKeys('everyone', AGENTS), ['regulatory', 'clinical', 'commercial']);
    assert.deepEqual(addresseeKeys('the panel', AGENTS), ['regulatory', 'clinical', 'commercial']);
  });

  it('returns [] for a name not on the roster', () => {
    assert.deepEqual(addresseeKeys('Dr. Smith', AGENTS), []);
  });

  it('does not add the same key twice for a repeated mention', () => {
    assert.deepEqual(addresseeKeys('Ruth and Ruth', AGENTS), ['regulatory']);
  });
});

describe('parseQuestionStatus', () => {
  it('reads RESOLVED', () => {
    assert.equal(parseQuestionStatus('QUESTION STATUS: RESOLVED — the answer given settles it.'), 'RESOLVED');
  });

  it('reads OPEN', () => {
    assert.equal(parseQuestionStatus('QUESTION STATUS: OPEN — still missing the disposición number.'), 'OPEN');
  });

  it('is case-insensitive and tolerates bold markers around the verdict', () => {
    assert.equal(parseQuestionStatus('question status: **resolved** — done.'), 'RESOLVED');
  });

  it('returns null when there is no QUESTION STATUS line', () => {
    assert.equal(parseQuestionStatus('Just a normal answer with no verdict line.'), null);
  });

  it('returns null for empty/undefined text', () => {
    assert.equal(parseQuestionStatus(''), null);
    assert.equal(parseQuestionStatus(undefined), null);
  });
});

describe('parseAnsweredCheck', () => {
  it('parses a fenced JSON reply', () => {
    const text = '```json\n{"answered": [{"id": "5", "seq": 3, "note": "Charlie gave a 12-18 month PAMI timeline"}]}\n```';

    const out = parseAnsweredCheck(text);

    assert.deepEqual(out, [{ id: '5', seq: 3, note: 'Charlie gave a 12-18 month PAMI timeline' }]);
  });

  it('parses JSON with prose wrapped around it', () => {
    const text = 'Here is what I found:\n{"answered": [{"id": "9", "seq": 4, "note": "answered"}]}\nHope that helps.';

    const out = parseAnsweredCheck(text);

    assert.deepEqual(out, [{ id: '9', seq: 4, note: 'answered' }]);
  });

  it('returns [] for invalid JSON between the braces', () => {
    const out = parseAnsweredCheck('{"answered": [ this is not valid json }');
    assert.deepEqual(out, []);
  });

  it('returns [] when there are no braces at all', () => {
    assert.deepEqual(parseAnsweredCheck('No JSON here, sorry.'), []);
  });

  it('returns [] when the "answered" key is missing or not an array', () => {
    assert.deepEqual(parseAnsweredCheck('{"nothing": "here"}'), []);
    assert.deepEqual(parseAnsweredCheck('{"answered": "not an array"}'), []);
  });

  it('drops entries with a non-numeric id, keeping numeric ones', () => {
    const text = '{"answered": [{"id": "abc", "seq": 1, "note": "bad id"}, {"id": "12", "seq": 2, "note": "good id"}]}';

    const out = parseAnsweredCheck(text);

    assert.deepEqual(out, [{ id: '12', seq: 2, note: 'good id' }]);
  });

  it('truncates an overlong note to 300 characters', () => {
    const longNote = 'x'.repeat(400);
    const text = JSON.stringify({ answered: [{ id: '1', seq: 1, note: longNote }] });

    const out = parseAnsweredCheck(text);

    assert.equal(out[0].note.length, 300);
    assert.equal(out[0].note, longNote.slice(0, 300));
  });

  it('returns [] for empty/undefined text', () => {
    assert.deepEqual(parseAnsweredCheck(''), []);
    assert.deepEqual(parseAnsweredCheck(undefined), []);
  });
});
