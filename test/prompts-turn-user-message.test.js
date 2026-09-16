'use strict';
// turnUserMessage is pure text assembly — no db/network on this path — so it
// is exercised directly. Requiring src/prompts.js also requires src/db.js,
// but db.js only opens a pg.Pool lazily (no connection at require time), and
// this worktree ships no .env / DATABASE_URL, so nothing here can touch a
// real database.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { turnUserMessage } = require('../src/prompts');

describe('turnUserMessage — autopilot question discussion', () => {
  it('uses the asker template, fills its placeholders, and gives no POSITION: AGREE/DISAGREE instruction', () => {
    const question = {
      text: 'Will ANMAT require local bridging data for a topical GTN product?',
      askerLabel: 'Luca (Clinical)',
      addresseesLabel: 'Charlie (Commercial)',
      role: 'asker',
    };

    const out = turnUserMessage({ agentKey: 'clinical', mode: 'autopilot', messages: [], question, max_chars: 600 });

    assert.ok(out.includes(question.text), 'the question text is substituted in');
    // The asker template speaks in the first person ("you asked …") — it has
    // no {{ASKER}} placeholder to fill, only {{ADDRESSEES}}.
    assert.ok(out.includes(question.addresseesLabel), 'ADDRESSEES placeholder substituted');
    // The asker template's own verdict-line instruction.
    assert.match(out, /QUESTION STATUS: RESOLVED/);
    assert.match(out, /QUESTION STATUS: OPEN/);
    // Not the disagreement/autopilot POSITION line format.
    assert.doesNotMatch(out, /POSITION:\s*(AGREE|DISAGREE)/);
    assert.ok(!out.includes('AUTOPILOT — the moderator has set this discussion'), 'the plain autopilot round text was not used');
  });

  it('uses the addressee template when the speaker was asked, not the asker', () => {
    const question = {
      text: 'What is the PAMI reimbursement timeline?',
      askerLabel: 'Luca (Clinical)',
      addresseesLabel: 'Charlie (Commercial)',
      role: 'addressee',
    };

    const out = turnUserMessage({ agentKey: 'commercial', mode: 'autopilot', messages: [], question, max_chars: 600 });

    assert.ok(out.includes(question.text));
    assert.ok(out.includes(question.askerLabel));
    assert.ok(out.includes(question.addresseesLabel));
    assert.match(out, /You are one of the people it was put to/);
    assert.doesNotMatch(out, /POSITION:\s*(AGREE|DISAGREE)/);
    assert.doesNotMatch(out, /QUESTION STATUS: RESOLVED/, 'the RESOLVED/OPEN verdict instruction belongs to the asker template only');
  });

  it('treats a "$&" inside the question text as literal text, not a regex replacement pattern', () => {
    // .replace(re, "$&") would insert the whole match instead of the literal
    // "$&" — the template code must use a function replacer to avoid this.
    const question = {
      text: 'Does "$&" break the substitution?',
      askerLabel: 'Ruth (Regulatory)',
      addresseesLabel: 'Luca (Clinical)',
      role: 'addressee',
    };

    const out = turnUserMessage({ agentKey: 'clinical', mode: 'autopilot', messages: [], question, max_chars: 'as_required' });

    assert.ok(out.includes('Does "$&" break the substitution?'), 'the literal question text, "$&" included, made it through unchanged');
  });

  it('appends the character limit line when max_chars is set, and omits it for "as_required"', () => {
    const question = { text: 'Q?', askerLabel: 'Ruth (Regulatory)', addresseesLabel: 'Luca (Clinical)', role: 'addressee' };

    const withLimit = turnUserMessage({ agentKey: 'clinical', mode: 'autopilot', messages: [], question, max_chars: 600 });
    const noLimit = turnUserMessage({ agentKey: 'clinical', mode: 'autopilot', messages: [], question, max_chars: 'as_required' });

    assert.match(withLimit, /Hard limit: 600 characters\./);
    assert.doesNotMatch(noLimit, /Hard limit:/);
  });

  it('never appends the compact-response suffix to a question discussion turn', () => {
    const question = { text: 'Q?', askerLabel: 'Ruth (Regulatory)', addresseesLabel: 'Luca (Clinical)', role: 'asker' };

    const out = turnUserMessage({ agentKey: 'regulatory', mode: 'autopilot', messages: [], question, max_chars: 600 });

    assert.ok(!out.includes('Keep this response compact: under 350 words'));
  });
});

describe('turnUserMessage — questions_check', () => {
  it('includes the OPEN QUESTIONS list from `instruction` and no compact-response suffix', () => {
    const list = '- id 5 · asked by Luca (Clinical) in message [3] to Charlie (Commercial): What is the PAMI timeline?';

    const out = turnUserMessage({ agentKey: 'moderator', mode: 'questions_check', messages: [], instruction: list });

    assert.match(out, /QUESTION CHECK/);
    assert.ok(out.includes('OPEN QUESTIONS:'));
    assert.ok(out.includes(list));
    assert.ok(!out.includes('Keep this response compact: under 350 words'));
  });

  it('falls back to "(none)" when no instruction is given', () => {
    const out = turnUserMessage({ agentKey: 'moderator', mode: 'questions_check', messages: [] });

    assert.match(out, /OPEN QUESTIONS:\n\(none\)/);
  });
});
