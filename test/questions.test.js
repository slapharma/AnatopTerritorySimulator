'use strict';
// src/questions.js is pure — no db, no network — so it's tested directly
// against the agents roster shape prompts.js builds from prompts/agents/index.json
// (key/name/short/function/label per agent).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseQuestions, addresseeKeys, parseQuestionStatus, parseAnsweredCheck, isAnsweredCheckReadable,
  questionMinutes, MINUTES_ROUND,
} = require('../src/questions');

describe('isAnsweredCheckReadable', () => {
  // The check's log line relies on this to tell "none answered" (readable,
  // empty list) from a reply the model did not write as the JSON asked for.
  it('is true for the expected object, including an empty answered list, fenced or not', () => {
    assert.equal(isAnsweredCheckReadable('{"answered": []}'), true);
    assert.equal(isAnsweredCheckReadable('```json\n{"answered":[{"id":"1","seq":2}]}\n```'), true);
  });
  it('is false for prose, broken JSON, or JSON without an answered list', () => {
    assert.equal(isAnsweredCheckReadable('None of the questions were answered.'), false);
    assert.equal(isAnsweredCheckReadable('{"answered": [ }'), false);
    assert.equal(isAnsweredCheckReadable('{"result": []}'), false);
    assert.equal(isAnsweredCheckReadable(''), false);
  });
});

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

// questionMinutes builds the minutes entry text/label/anchor for one action on
// one question. It is pure: no db, so `messages` and `label` (name lookup) are
// passed in exactly as src/app.js's recordQuestionMinutes supplies them.
describe('questionMinutes', () => {
  const NAME = { regulatory: 'Ruth', clinical: 'Luca', commercial: 'Charlie', moderator: 'the Moderator' };
  const label = (k) => NAME[k] || k;
  const baseQuestion = (over = {}) => ({
    id: '1', message_id: '10', n: 1, asker: 'clinical', addressees: 'commercial',
    round: 'opening', text: 'What is the PAMI timeline?', ...over,
  });
  const ap = (run_id, cycle) => JSON.stringify({ autopilot: { run_id, cycle } });

  it('MINUTES_ROUND is "question"', () => {
    assert.equal(MINUTES_ROUND, 'question');
  });

  it('action "answer": labels who answered, refs the answer message, and shows the status transition', () => {
    const question = baseQuestion();
    const asked = { id: '10', seq: 3 };
    const answerMessage = { id: '55', seq: 7 };
    const entry = questionMinutes({ question, action: 'answer', from: 'open', to: 'answered', answerMessage, messages: [asked, answerMessage], label });

    assert.equal(entry.label, 'Question answered by the moderator · Luca → Charlie');
    assert.match(entry.text, /The moderator answered it in message #7\./);
    assert.match(entry.text, /Asked in Baselines, message #3\./);
    assert.match(entry.text, /\*\*Status:\*\* Open → Answered/);
    assert.equal(entry.anchor_message_id, 55);
  });

  it('action "check": labels it found-answered by the Moderator Assistant', () => {
    const answerMessage = { id: '9', seq: 4 };
    const entry = questionMinutes({ question: baseQuestion(), action: 'check', from: 'open', to: 'answered', answerMessage, messages: [answerMessage], label });

    assert.match(entry.label, /^Question found answered ·/);
    assert.match(entry.text, /The Moderator Assistant found it answered in message #4\./);
  });

  it('action "status" to "open": reopened wording, no answer ref required', () => {
    const entry = questionMinutes({ question: baseQuestion(), action: 'status', from: 'answered', to: 'open', messages: [], label });

    assert.match(entry.label, /^Question reopened ·/);
    assert.match(entry.text, /The moderator reopened it\./);
    assert.match(entry.text, /\*\*Status:\*\* Answered → Open/);
  });

  it('action "status" to "escalated": escalated wording', () => {
    const entry = questionMinutes({ question: baseQuestion(), action: 'status', from: 'open', to: 'escalated', messages: [], label });

    assert.match(entry.label, /^Question escalated ·/);
    assert.match(entry.text, /The moderator escalated it for offline review\./);
  });

  it('action "status" to "resolved": "marked resolved" wording', () => {
    const entry = questionMinutes({ question: baseQuestion(), action: 'status', from: 'escalated', to: 'resolved', messages: [], label });

    assert.match(entry.label, /^Question marked resolved ·/);
    assert.match(entry.text, /The moderator marked it resolved\./);
  });

  it('says "no one named" and "unaddressed" when the question has no addressees', () => {
    const entry = questionMinutes({ question: baseQuestion({ addressees: '' }), action: 'status', from: 'open', to: 'escalated', messages: [], label });

    assert.match(entry.text, /Luca asked no one named:/);
    assert.match(entry.label, /Luca → unaddressed/);
  });

  it('names "moderator" in the addressee list using the given label function', () => {
    const entry = questionMinutes({ question: baseQuestion({ addressees: 'commercial,moderator' }), action: 'status', from: 'open', to: 'escalated', messages: [], label });

    assert.match(entry.text, /Luca asked Charlie and the Moderator:/);
  });

  it('caps the label at 200 characters', () => {
    const longLabel = (k) => `${k}-name`.repeat(40);
    const entry = questionMinutes({ question: baseQuestion(), action: 'answer', from: 'open', to: 'answered', answerMessage: null, messages: [], label: longLabel });

    assert.equal(entry.label.length, 200);
  });

  it('includes a given note, one-lined', () => {
    const entry = questionMinutes({ question: baseQuestion(), action: 'status', from: 'open', to: 'escalated', note: 'Needs   offline   review\nplease', messages: [], label });

    assert.match(entry.text, /\*\*Note:\*\* Needs offline review please/);
  });

  it('omits the note line when none is given', () => {
    const entry = questionMinutes({ question: baseQuestion(), action: 'status', from: 'open', to: 'escalated', messages: [], label });

    assert.doesNotMatch(entry.text, /\*\*Note:\*\*/);
  });

  it('falls back to "the transcript" when the question has no round at all', () => {
    const entry = questionMinutes({ question: baseQuestion({ round: null }), action: 'status', from: 'open', to: 'escalated', messages: [], label });

    assert.match(entry.text, /Asked in the transcript\./);
  });

  it('shows the raw round value when it is not one of the known rounds', () => {
    const entry = questionMinutes({ question: baseQuestion({ round: 'made_up_round' }), action: 'status', from: 'open', to: 'escalated', messages: [], label });

    assert.match(entry.text, /Asked in made_up_round\./);
  });

  it('anchors to the original question message when no answer message is given', () => {
    const question = baseQuestion({ message_id: '10' });
    const asked = { id: '10', seq: 4 };
    const entry = questionMinutes({ question, action: 'status', from: 'answered', to: 'open', messages: [asked], label });

    assert.equal(entry.anchor_message_id, 10);
  });

  it('leaves anchor_message_id null when the anchor message id is not purely numeric', () => {
    const entry = questionMinutes({ question: baseQuestion(), action: 'answer', from: 'open', to: 'answered', answerMessage: { id: 'not-a-number', seq: 9 }, messages: [], label });

    assert.equal(entry.anchor_message_id, null);
  });

  it('marks the status "(unchanged)" when from and to are equal', () => {
    const entry = questionMinutes({ question: baseQuestion(), action: 'status', from: 'open', to: 'open', messages: [], label });

    assert.match(entry.text, /\*\*Status:\*\* Open \(unchanged\)/);
  });

  describe('action "discussion"', () => {
    it('falls back to "stopped" for an outcome not in OUTCOME_LABEL, and pluralises "loop(s)" correctly', () => {
      const entry = questionMinutes({
        question: baseQuestion(), action: 'discussion', from: 'open', to: 'escalated',
        discussion: { run_id: 'r1', outcome: 'weird_outcome', cycles: 1 }, messages: [], label,
      });

      assert.match(entry.text, /Discussed to resolution over 1 loop: stopped\./);
      // from !== to: the verb names the status it landed on, not the outcome.
      assert.match(entry.label, /discussed: escalated to moderator/);
    });

    it('names the outcome directly in the verb when the status did not change', () => {
      const entry = questionMinutes({
        question: baseQuestion(), action: 'discussion', from: 'open', to: 'open',
        discussion: { run_id: 'r1', outcome: 'resolved', cycles: 3 }, messages: [], label,
      });

      assert.match(entry.label, /discussed: resolved by the asker/);
      assert.match(entry.text, /Discussed to resolution over 3 loops: resolved by the asker\./);
      assert.match(entry.text, /\*\*Status:\*\* Open \(unchanged\)/);
    });

    it('treats a non-numeric cycles count as 0', () => {
      const entry = questionMinutes({
        question: baseQuestion(), action: 'discussion', from: 'open', to: 'open',
        discussion: { run_id: 'r1', outcome: 'resolved', cycles: 'abc' }, messages: [], label,
      });

      assert.match(entry.text, /Discussed to resolution over 0 loops: resolved by the asker\./);
    });

    it('lists contributions per loop in order, only for the matching run, excluding system notes and marking failed turns', () => {
      const question = baseQuestion({ asker: 'clinical', addressees: 'commercial', message_id: '1' });
      const messages = [
        { id: '1', seq: 1, role: 'agent', speaker: 'clinical', text: 'the question itself' },
        { id: '2', seq: 2, role: 'agent', speaker: 'commercial', text: 'loop1 addressee', content_json: ap('r1', 1) },
        { id: '3', seq: 3, role: 'system', speaker: 'autopilot', text: 'a system note', content_json: ap('r1', 1) },
        { id: '4', seq: 4, role: 'agent', speaker: 'clinical', text: 'loop1 asker, still open', content_json: ap('r1', 1) },
        { id: '5', seq: 5, role: 'agent', speaker: 'commercial', text: 'loop2 addressee', content_json: ap('r1', 2), error: 'boom' },
        { id: '6', seq: 6, role: 'agent', speaker: 'clinical', text: 'loop2 asker, resolved', content_json: ap('r1', 2) },
        { id: '7', seq: 7, role: 'agent', speaker: 'commercial', text: 'a different run entirely', content_json: ap('r2', 1) },
      ];
      const entry = questionMinutes({
        question, action: 'discussion', from: 'open', to: 'resolved',
        discussion: { run_id: 'r1', outcome: 'resolved', cycles: 2 }, messages, label,
      });

      assert.match(entry.text, /\*\*Contributions:\*\*/);
      assert.match(entry.text, /- Loop 1: Charlie #2, Luca #4/);
      assert.match(entry.text, /- Loop 2: Charlie #5 \(failed\), Luca #6/);
      assert.doesNotMatch(entry.text, /#3/, 'the system note (id 3) must not appear');
      assert.doesNotMatch(entry.text, /#7/, 'a message from a different run must not appear');
      // No answer message given and the run is non-empty: anchors to the run's last message.
      assert.equal(entry.anchor_message_id, 6);
    });

    it('excludes messages from another run_id from the loop count entirely', () => {
      const question = baseQuestion({ asker: 'clinical', addressees: 'commercial' });
      const messages = [
        { id: '1', seq: 1, role: 'agent', speaker: 'commercial', text: 'other run', content_json: ap('r2', 1) },
      ];
      const entry = questionMinutes({
        question, action: 'discussion', from: 'open', to: 'escalated',
        discussion: { run_id: 'r1', outcome: 'cycle_cap', cycles: 1 }, messages, label,
      });

      assert.doesNotMatch(entry.text, /\*\*Contributions:\*\*/);
    });

    it('takes the verdict from the last QUESTION STATUS line in the asker\'s final turn, even when an earlier one is quoted in the body', () => {
      const question = baseQuestion({ asker: 'clinical', addressees: 'commercial' });
      const messages = [
        {
          id: '1', seq: 1, role: 'agent', speaker: 'clinical',
          text: 'Earlier I said QUESTION STATUS: OPEN — not yet.\n\nBut now: QUESTION STATUS: RESOLVED — got the answer.',
          content_json: ap('r1', 1),
        },
      ];
      const entry = questionMinutes({
        question, action: 'discussion', from: 'open', to: 'resolved',
        discussion: { run_id: 'r1', outcome: 'resolved', cycles: 1 }, messages, label,
      });

      assert.match(entry.text, /\*\*Luca's verdict:\*\* RESOLVED — got the answer\./);
    });

    it('omits the verdict line when the asker\'s final turn has no QUESTION STATUS line', () => {
      const question = baseQuestion({ asker: 'clinical', addressees: 'commercial' });
      const messages = [
        { id: '1', seq: 1, role: 'agent', speaker: 'clinical', text: 'Sounds good to me.', content_json: ap('r1', 1) },
      ];
      const entry = questionMinutes({
        question, action: 'discussion', from: 'open', to: 'resolved',
        discussion: { run_id: 'r1', outcome: 'resolved', cycles: 1 }, messages, label,
      });

      assert.doesNotMatch(entry.text, /verdict/);
    });

    it('anchors to the answer message over the run\'s last message when both are given', () => {
      const question = baseQuestion({ asker: 'clinical', addressees: 'commercial' });
      const messages = [
        { id: '1', seq: 1, role: 'agent', speaker: 'commercial', text: 'in the run', content_json: ap('r1', 1) },
      ];
      const answerMessage = { id: '42', seq: 9 };
      const entry = questionMinutes({
        question, action: 'discussion', from: 'open', to: 'answered',
        discussion: { run_id: 'r1', outcome: 'resolved', cycles: 1 }, answerMessage, messages, label,
      });

      assert.equal(entry.anchor_message_id, 42);
    });
  });
});
