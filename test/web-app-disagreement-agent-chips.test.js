'use strict';
// web/app.js is a browser IIFE, so (as in the other web/app.js vm tests)
// evaluate parseDisagreementBody/disRowsHtml/agentKeyFromText/disRaisedBy in
// a vm context against a fake state and roster, the way the app itself calls
// them.
//
// Disagreement rows now carry which agent took each position — "Position A
// (Ruth): ..." — so the tab can show a coloured chip next to Position A/B
// instead of leaving the reader to infer who said what. Matching the name in
// that parenthetical back to an agent key has to be loose (the model writes
// "Ruth", "Luca - Clinical", "Charlie (Commercial)", the raw key, ...) but
// still exact enough that a function name like "Clinical" doesn't match
// inside an unrelated word like "preclinical".
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const ALL = ['regulatory', 'clinical', 'commercial']; // Ruth, Luca, Charlie

const AGENT_LABEL = { regulatory: 'Ruth', clinical: 'Luca', commercial: 'Charlie', moderator: 'Moderator Assistant' };
const AGENT_COLOUR = { regulatory: '#a00', clinical: '#0a0', commercial: '#00a' };
const AGENTS_CONFIG = {
  regulatory: { name: 'Ruth', short: 'Ruth', function: 'Regulatory' },
  clinical: { name: 'Luca', short: 'Luca', function: 'Clinical' },
  commercial: { name: 'Charlie', short: 'Charlie', function: 'Commercial' },
};

function loadHelpers({ messages = [] } = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf('  // Splits the stored');
  const end = src.indexOf('  // Clicking a disagreement card opens the full detail');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did parseDisagreementBody/disRaisedHtml move?');

  const ctx = {
    ALL,
    AGENT_LABEL,
    AGENT_COLOUR,
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    state: { config: { agents: AGENTS_CONFIG }, session: { messages } },
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}
this.parseDisagreementBody = parseDisagreementBody;
this.disRowsHtml = disRowsHtml;
this.agentKeyFromText = agentKeyFromText;
this.agentChipHtml = agentChipHtml;
this.disRaisedBy = disRaisedBy;
this.disRaisedHtml = disRaisedHtml;`, ctx);
  return ctx;
}

describe('web/app.js parseDisagreementBody', () => {
  it('captures the agent named in a Position A/B parenthetical', () => {
    const ctx = loadHelpers();
    const body = [
      'Position A (Ruth): We believe launch should wait for the label update.',
      'Position B (Luca - Clinical): We believe launch can proceed now.',
      'What evidence would settle it: The revised SmPC draft.',
      'Status: unresolved',
    ].join('\n');

    // Objects built inside the vm context are a different realm's Object, so
    // deepEqual's reference check on the prototype fails even when the shape
    // matches — round-trip through JSON to compare plain data.
    const rows = JSON.parse(JSON.stringify(ctx.parseDisagreementBody(body)));

    assert.deepEqual(rows, [
      { label: 'Position A', agent: 'Ruth', text: 'We believe launch should wait for the label update.' },
      { label: 'Position B', agent: 'Luca - Clinical', text: 'We believe launch can proceed now.' },
      { label: 'What evidence would settle it', agent: '', text: 'The revised SmPC draft.' },
      { label: 'Status', agent: '', text: 'unresolved' },
    ]);
  });

  it('leaves agent empty for a Position row with no parenthetical', () => {
    const ctx = loadHelpers();
    const rows = JSON.parse(JSON.stringify(ctx.parseDisagreementBody('Position A: We believe launch should wait.')));
    assert.deepEqual(rows, [{ label: 'Position A', agent: '', text: 'We believe launch should wait.' }]);
  });
});

describe('web/app.js agentKeyFromText', () => {
  it('matches a bare first name', () => {
    const ctx = loadHelpers();
    assert.equal(ctx.agentKeyFromText('Ruth'), 'regulatory');
  });

  it('matches "name - function"', () => {
    const ctx = loadHelpers();
    assert.equal(ctx.agentKeyFromText('Luca - Clinical'), 'clinical');
  });

  it('matches "name (function)"', () => {
    const ctx = loadHelpers();
    assert.equal(ctx.agentKeyFromText('Charlie (Commercial)'), 'commercial');
  });

  it('matches the raw agent key, case-insensitively', () => {
    const ctx = loadHelpers();
    assert.equal(ctx.agentKeyFromText('commercial'), 'commercial');
  });

  it('returns null for a name not on the roster', () => {
    const ctx = loadHelpers();
    assert.equal(ctx.agentKeyFromText('Moderator'), null);
  });

  it('returns null for empty text', () => {
    const ctx = loadHelpers();
    assert.equal(ctx.agentKeyFromText(''), null);
  });

  it('does not match a function name as a substring of an unrelated word', () => {
    const ctx = loadHelpers();
    assert.equal(ctx.agentKeyFromText('preclinical'), null);
  });
});

describe('web/app.js disRowsHtml', () => {
  it('renders an agent chip with the agent label inside the Position label', () => {
    const ctx = loadHelpers();
    const rows = ctx.disRowsHtml({ body: 'Position A (Ruth): We believe launch should wait.' });
    assert.match(rows, /class="dis-label">Position A<span class="agent-chip"[^>]*>Ruth<\/span><\/span>/);
  });

  it('renders no agent chip when the row names no agent', () => {
    const ctx = loadHelpers();
    const rows = ctx.disRowsHtml({ body: 'Status: unresolved' });
    assert.doesNotMatch(rows, /agent-chip/);
    assert.match(rows, /class="dis-label">Status<\/span>/);
  });
});

describe('web/app.js disRaisedBy', () => {
  it('returns the speaker of the disagreement\'s message when it is an agent', () => {
    const ctx = loadHelpers({ messages: [{ id: 5, speaker: 'clinical' }, { id: 6, speaker: 'moderator' }] });
    assert.equal(ctx.disRaisedBy({ message_id: 5 }), 'clinical');
  });

  it('returns null when the message was sent by the moderator, not an agent', () => {
    const ctx = loadHelpers({ messages: [{ id: 5, speaker: 'clinical' }, { id: 6, speaker: 'moderator' }] });
    assert.equal(ctx.disRaisedBy({ message_id: 6 }), null);
  });

  it('returns null when the disagreement has no message_id', () => {
    const ctx = loadHelpers({ messages: [{ id: 5, speaker: 'clinical' }] });
    assert.equal(ctx.disRaisedBy({ message_id: null }), null);
  });

  it('returns null when message_id points at a message that no longer exists', () => {
    const ctx = loadHelpers({ messages: [{ id: 5, speaker: 'clinical' }] });
    assert.equal(ctx.disRaisedBy({ message_id: 999 }), null);
  });
});
