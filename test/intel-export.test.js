'use strict';
// src/intel-export.js turns one Intelligence tab (from db.fullSession) into
// { key, title, markdown } for src/export.js to render as Word/PDF. Pure
// module — requires src/prompts (which requires src/db, never connecting: no
// DATABASE_URL in this worktree, same as test/db-questions.test.js).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sectionDoc, SECTIONS } = require('../src/intel-export');

// Minimal but complete fullSession() shape every builder reads from.
function baseSession(overrides = {}) {
  return {
    id: 39,
    title: 'Anatop · Argentina',
    inputs: { product: 'Anatop', country: 'Argentina' },
    messages: [],
    sources: [],
    disagreements: [],
    questions: [],
    reports: [],
    meeting_minutes: [],
    decision_text: null,
    ...overrides,
  };
}

describe('sectionDoc — routing', () => {
  it('returns null for a key the module does not know', () => {
    assert.equal(sectionDoc(baseSession(), 'bogus'), null);
  });

  it('returns null for __proto__, not Object.prototype leaking through', () => {
    assert.equal(sectionDoc(baseSession(), '__proto__'), null);
  });

  it('returns null for toString, constructor and hasOwnProperty — inherited names, not real sections', () => {
    for (const key of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
      assert.equal(sectionDoc(baseSession(), key), null, `${key} must not resolve to a section`);
    }
  });

  it('returns {key, title, markdown} for every declared section', () => {
    for (const key of Object.keys(SECTIONS)) {
      const doc = sectionDoc(baseSession(), key);
      assert.ok(doc, `expected a doc for "${key}"`);
      assert.equal(doc.key, key);
      assert.equal(doc.title, SECTIONS[key].title);
      assert.equal(typeof doc.markdown, 'string');
    }
  });

  it('passes opts (e.g. cut) through to the section builder', () => {
    const s = baseSession({
      messages: [
        { id: '1', role: 'agent', speaker: 'clinical', mode: 'opening', seq: 1, text: 'Baseline text', favourite: false, error: null },
      ],
    });
    const byMeeting = sectionDoc(s, 'intelligence', { cut: 'meeting' });
    const byAgent = sectionDoc(s, 'intelligence', { cut: 'agent' });
    assert.match(byMeeting.markdown, /## Baselines/);
    assert.match(byAgent.markdown, /## Luca \(Clinical\)/);
  });
});

describe('sources()', () => {
  it('shows the empty-state placeholder in italics when nothing has been cited', () => {
    const doc = sectionDoc(baseSession({ sources: [] }), 'sources');
    assert.equal(doc.markdown, '_No sources have been cited in a claim yet._');
  });

  it('lists cited sources with their citation number, escaped title, and citing agents', () => {
    const s = baseSession({
      sources: [
        {
          n: 1, kind: 'cited', title: 'PAMI [listing] rules | 2024', url: 'https://example.com/pami',
          first_cited_at: '2024-01-02T03:04:05.000Z', cited_by: [{ speaker: 'clinical' }, { speaker: 'clinical' }, { speaker: 'commercial' }],
        },
      ],
    });
    const doc = sectionDoc(s, 'sources');
    assert.match(doc.markdown, /\*\*1\.\*\* \[PAMI \(listing\) rules \/ 2024\]\(https:\/\/example\.com\/pami\)/);
    assert.match(doc.markdown, /cited 2024-01-02 03:04:05 UTC/);
    assert.match(doc.markdown, /Luca \(Clinical\), Charlie \(Commercial\)/, 'de-duplicated citing agents, in first-seen order');
  });

  it('reports additional searched-but-uncited pages as a separate italic note', () => {
    const s = baseSession({
      sources: [
        { n: 1, kind: 'cited', title: 'A', url: 'https://a', first_cited_at: '2024-01-01T00:00:00Z', cited_by: [] },
        { n: 2, kind: 'searched', title: 'B', url: 'https://b', first_cited_at: null, cited_by: [] },
        { n: 3, kind: 'searched', title: 'C', url: 'https://c', first_cited_at: null, cited_by: [] },
      ],
    });
    const doc = sectionDoc(s, 'sources');
    assert.match(doc.markdown, /2 additional page\(s\) were searched but not cited in any claim\./);
  });
});

describe('sources() — a URL containing brackets', () => {
  it('encodes ( and ) in the URL so the whole address survives as one link', () => {
    const { parseBlocks } = require('../src/markdown-blocks');
    const url = 'https://en.wikipedia.org/wiki/Foo_(bar)';
    const s = baseSession({ sources: [{ n: 1, kind: 'cited', title: 'Foo', url, first_cited_at: null, cited_by: [] }] });
    const [block] = parseBlocks(sectionDoc(s, 'sources').markdown);
    const link = block.runs.find((r) => r.link);
    assert.equal(link.link, 'https://en.wikipedia.org/wiki/Foo_%28bar%29');
    assert.equal(block.runs.some((r) => !r.link && r.text.startsWith(')')), false, 'no stray ) after the link');
  });
});

describe('disagreements()', () => {
  it('empty state', () => {
    const doc = sectionDoc(baseSession(), 'disagreements');
    assert.equal(doc.markdown, '_No disagreements were logged._');
  });

  it('renders each disagreement with number, escaped topic, uppercase status and body', () => {
    const s = baseSession({
      disagreements: [{ n: 2, topic: 'Timeline [PAMI] risk | high', status: 'open', body: 'Body text here.' }],
    });
    const doc = sectionDoc(s, 'disagreements');
    assert.match(doc.markdown, /^## #2 Timeline \(PAMI\) risk \/ high — OPEN/);
    assert.match(doc.markdown, /Body text here\./);
  });
});

describe('questions()', () => {
  it('empty state', () => {
    const doc = sectionDoc(baseSession(), 'questions');
    assert.equal(doc.markdown, '_No questions logged yet._');
  });

  it('groups by status in the fixed order open, escalated, answered, resolved, skipping empty groups', () => {
    const s = baseSession({
      messages: [{ id: '10', seq: 1 }],
      questions: [
        { message_id: '10', asker: 'clinical', addressees: 'commercial', status: 'resolved', text: 'Q-resolved', round: 'opening', resolution_note: null },
        { message_id: '10', asker: 'clinical', addressees: 'commercial', status: 'open', text: 'Q-open', round: 'opening', resolution_note: null },
        { message_id: '10', asker: 'clinical', addressees: 'commercial', status: 'escalated', text: 'Q-escalated', round: 'opening', resolution_note: null },
      ],
    });
    const doc = sectionDoc(s, 'questions');
    const order = [...doc.markdown.matchAll(/## ([A-Za-z]+(?: to moderator)?) \(1\)/g)].map((m) => m[1]);
    assert.deepEqual(order, ['Open', 'Escalated to moderator', 'Resolved']);
    assert.doesNotMatch(doc.markdown, /## Answered/, 'no heading for a status with zero questions');
  });

  it('a question block shows asker, addressees, status, the round it was asked in, and a safe()-escaped resolution note', () => {
    const s = baseSession({
      messages: [{ id: '10', seq: 4 }],
      questions: [{
        message_id: '10', asker: 'clinical', addressees: 'commercial,regulatory', status: 'answered', text: 'What now?',
        round: 'round2', resolution_note: 'Resolved via [PAMI] filing | done',
      }],
    });
    const doc = sectionDoc(s, 'questions');
    assert.match(doc.markdown, /### Luca \(Clinical\) → Charlie \(Commercial\), Ruth \(Regulatory\)/);
    assert.match(doc.markdown, /\*\*Status:\*\* Answered/);
    assert.match(doc.markdown, /\*\*Asked in:\*\* Challenge \(#4\)/);
    assert.match(doc.markdown, /\*\*Outcome:\*\* Resolved via \(PAMI\) filing \/ done/);
  });

  it('falls back to "the transcript" when the asking message cannot be found', () => {
    const s = baseSession({
      messages: [],
      questions: [{ message_id: 'missing', asker: 'clinical', addressees: 'commercial', status: 'open', text: 'Q?', round: null, resolution_note: null }],
    });
    const doc = sectionDoc(s, 'questions');
    assert.match(doc.markdown, /\*\*Asked in:\*\* the transcript/);
  });
});

describe('escalations()', () => {
  it('empty state reads "Nothing is escalated."', () => {
    const doc = sectionDoc(baseSession(), 'escalations');
    assert.equal(doc.markdown, '_Nothing is escalated._');
  });

  it('lists only escalated questions, in original order', () => {
    const s = baseSession({
      messages: [],
      questions: [
        { message_id: '1', asker: 'clinical', addressees: 'commercial', status: 'open', text: 'Not escalated', round: null, resolution_note: null },
        { message_id: '1', asker: 'commercial', addressees: 'clinical', status: 'escalated', text: 'Escalated one', round: null, resolution_note: null },
      ],
    });
    const doc = sectionDoc(s, 'escalations');
    assert.match(doc.markdown, /Escalated one/);
    assert.doesNotMatch(doc.markdown, /Not escalated/);
  });
});

describe('decision()', () => {
  it('shows placeholders for both decision text and reports when neither exists', () => {
    const doc = sectionDoc(baseSession(), 'decision');
    assert.match(doc.markdown, /_No decision output has been written for this session yet\._/);
    assert.match(doc.markdown, /_No reports generated yet\._/);
  });

  it('renders the decision text verbatim and every report with kind, depth and timestamp', () => {
    const s = baseSession({
      decision_text: 'Go, with conditions.',
      reports: [{ kind: 'final', depth: 'full', created_at: '2024-02-03T04:05:06Z', text: 'Full report body.' }],
    });
    const doc = sectionDoc(s, 'decision');
    assert.match(doc.markdown, /Go, with conditions\./);
    assert.match(doc.markdown, /### Final report · Full · 2024-02-03 04:05:06 UTC/);
    assert.match(doc.markdown, /Full report body\./);
  });
});

describe('favourites()', () => {
  it('empty state', () => {
    const doc = sectionDoc(baseSession(), 'favourites');
    assert.equal(doc.markdown, '_No favourites yet._');
  });

  it('includes only favourited, non-system messages', () => {
    const s = baseSession({
      messages: [
        { id: '1', role: 'agent', speaker: 'clinical', mode: 'opening', seq: 1, favourite: true, text: 'Kept.' },
        { id: '2', role: 'agent', speaker: 'commercial', mode: 'opening', seq: 2, favourite: false, text: 'Not favourited.' },
        { id: '3', role: 'system', speaker: 'system', mode: 'opening', seq: 3, favourite: true, text: 'System favourite, excluded.' },
      ],
    });
    const doc = sectionDoc(s, 'favourites');
    assert.match(doc.markdown, /Kept\./);
    assert.doesNotMatch(doc.markdown, /Not favourited\./);
    assert.doesNotMatch(doc.markdown, /System favourite, excluded\./);
  });
});

describe('minutes()', () => {
  it('empty state', () => {
    const doc = sectionDoc(baseSession(), 'minutes');
    assert.equal(doc.markdown, '_No minutes yet._');
  });

  it('shows Approved/Pending approval for a meeting round, and no state suffix for a question entry', () => {
    const s = baseSession({
      meeting_minutes: [
        { round: 'opening', label: 'Baselines held', approved: true, created_at: '2024-01-01T00:00:00Z', text: 'body' },
        { round: 'opening', label: 'Baselines pending', approved: false, created_at: '2024-01-01T00:00:00Z', text: 'body' },
        { round: 'question', label: 'Question answered', approved: false, created_at: '2024-01-01T00:00:00Z', text: 'body' },
      ],
    });
    const doc = sectionDoc(s, 'minutes');
    assert.match(doc.markdown, /## 1\. Baselines held — Approved/);
    assert.match(doc.markdown, /## 2\. Baselines pending — Pending approval/);
    assert.match(doc.markdown, /## 3\. Question answered\n/, 'no " — " state suffix for a question round');
  });
});

describe('inputs()', () => {
  it('renders a two-column table, marking a blank field INPUT MISSING and escaping bracket/pipe characters', () => {
    const s = baseSession({ inputs: { product: 'Anatop [Cream] | 2%', country: '' } });
    const doc = sectionDoc(s, 'inputs');
    assert.match(doc.markdown, /\| PRODUCT \| Anatop \(Cream\) \/ 2% \|/);
    assert.match(doc.markdown, /\| COUNTRY \| _INPUT MISSING_ \|/);
  });
});

describe('agentNotes() — the four Agent notes cuts', () => {
  const messages = [
    { id: '1', role: 'agent', speaker: 'clinical', mode: 'opening', seq: 1, text: 'Luca opening.', error: null },
    { id: '2', role: 'agent', speaker: 'commercial', mode: 'opening', seq: 2, text: 'Charlie opening.', error: null },
    { id: '3', role: 'user', speaker: 'user', mode: 'reply', seq: 3, text: 'Moderator asks something.', error: null },
    { id: '4', role: 'system', speaker: 'system', mode: 'opening', seq: 4, text: 'System note, always excluded.', error: null },
    { id: '5', role: 'agent', speaker: 'clinical', mode: 'round2', seq: 5, text: null, error: null }, // still in flight
    { id: '6', role: 'agent', speaker: 'clinical', mode: 'round2', seq: 6, text: 'Failed.', error: 'boom' },
  ];

  it('default (agent) cut groups spoken, non-error, non-null-text messages by speaker', () => {
    const doc = sectionDoc(baseSession({ messages }), 'intelligence', { cut: 'agent' });
    assert.match(doc.markdown, /## Luca \(Clinical\) \(1\)/, 'only the one qualifying clinical message counts');
    assert.match(doc.markdown, /## Charlie \(Commercial\) \(1\)/);
    assert.match(doc.markdown, /## Moderator \(human\) \(1\)/);
    assert.doesNotMatch(doc.markdown, /System note, always excluded\./);
    assert.doesNotMatch(doc.markdown, /Failed\./, 'an errored message is excluded, not shown as an empty turn');
  });

  it('meeting cut groups by mode label instead of speaker', () => {
    const doc = sectionDoc(baseSession({ messages }), 'intelligence', { cut: 'meeting' });
    assert.match(doc.markdown, /## Baselines \(2\)/);
    assert.match(doc.markdown, /## Reply \(1\)/);
  });

  it('empty transcript reports "No messages yet."', () => {
    const doc = sectionDoc(baseSession({ messages: [] }), 'intelligence', { cut: 'agent' });
    assert.equal(doc.markdown, '_No messages yet._');
  });

  it('disagreement cut lists topic and status, ignoring cut when there are none logged', () => {
    const doc = sectionDoc(baseSession({ disagreements: [] }), 'intelligence', { cut: 'disagreement' });
    assert.equal(doc.markdown, '_No disagreements logged._');

    const withDis = sectionDoc(baseSession({ disagreements: [{ n: 1, topic: 'Pricing', status: 'open' }] }), 'intelligence', { cut: 'disagreement' });
    assert.match(withDis.markdown, /- \*\*#1\*\* Pricing — OPEN/);
  });

  it('resolution cut splits into Unresolved and Resolved sections with counts', () => {
    const s = baseSession({
      disagreements: [
        { n: 1, topic: 'Pricing', status: 'open' },
        { n: 2, topic: 'Timeline', status: 'resolved' },
      ],
    });
    const doc = sectionDoc(s, 'intelligence', { cut: 'resolution' });
    assert.match(doc.markdown, /## Unresolved \(1\)\n\n- \*\*#1\*\* Pricing/);
    assert.match(doc.markdown, /## Resolved \(1\)\n\n- \*\*#2\*\* Timeline/);
    assert.doesNotMatch(doc.markdown, /OPEN|RESOLVED/, 'resolution cut lines carry no status suffix, unlike the disagreement cut');
  });

  it('resolution cut with no disagreements shows "None." in both buckets, not the top-level empty state', () => {
    const doc = sectionDoc(baseSession({ disagreements: [] }), 'intelligence', { cut: 'resolution' });
    assert.equal(doc.markdown, '_No disagreements logged._');
  });
});
