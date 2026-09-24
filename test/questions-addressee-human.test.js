'use strict';
// src/questions.js addresseeKeys: "the Moderator (the human)" is the exact
// wording prompts/evidence-rules.md uses. Kept inline, the parenthetical used
// to leave "the Moderator  the human" — two words that matched no one on the
// roster — and the whole question block was silently dropped. Regression
// coverage for the fix (the parenthetical is now stripped as a gloss on the
// name before it, not read as a second addressee).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { addresseeKeys, parseQuestions } = require('../src/questions');

const AGENTS = {
  regulatory: { key: 'regulatory', name: 'Ruth', short: 'Ruth', function: 'Regulatory', label: 'Ruth (Regulatory)' },
  clinical: { key: 'clinical', name: 'Luca', short: 'Luca', function: 'Clinical', label: 'Luca (Clinical)' },
};

describe('addresseeKeys — "(the human)" parenthetical', () => {
  it('maps "the Moderator (the human)" to moderator alone, not two mismatched fragments', () => {
    assert.deepEqual(addresseeKeys('the Moderator (the human)', AGENTS), ['moderator']);
  });

  it('still maps a bare "Moderator" with no parenthetical', () => {
    assert.deepEqual(addresseeKeys('Moderator', AGENTS), ['moderator']);
  });

  it('a heading using the full phrase is still parsed into a question, end to end', () => {
    const text = ['Questions for the Moderator (the human):', '1. Should we proceed without local bridging data?'].join('\n');
    const out = parseQuestions(text, AGENTS, 'regulatory');
    assert.deepEqual(out, [{ addressees: ['moderator'], n: 1, text: 'Should we proceed without local bridging data?' }]);
  });

  it('a parenthetical after a real agent name is also stripped as a gloss, not a second addressee', () => {
    assert.deepEqual(addresseeKeys('Ruth (Regulatory) and the Moderator (the human)', AGENTS), ['regulatory', 'moderator']);
  });
});
