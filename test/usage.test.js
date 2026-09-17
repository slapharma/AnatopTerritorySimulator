'use strict';
// src/usage.js is pure (no db, no config) — classify() decides which category
// and feature a runTurn call belongs to; summarise() merges the llm_calls
// ledger with pre-ledger cost on messages/reports without double counting.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORIES, FEATURE_LABEL, classify, summarise } = require('../src/usage');

describe('classify', () => {
  it('classifies the questions answered-check', () => {
    assert.deepEqual(classify({ mode: 'questions_check' }), { category: 'question_resolution', feature: 'questions_check' });
  });

  it('classifies meeting minutes', () => {
    assert.deepEqual(classify({ mode: 'meeting_minutes' }), { category: 'meeting_minutes', feature: 'meeting_minutes' });
  });

  it('classifies an interim report when report_kind is absent', () => {
    assert.deepEqual(classify({ mode: 'report' }), { category: 'reports', feature: 'report_interim' });
  });

  it('classifies an interim report for any report_kind other than "final"', () => {
    assert.deepEqual(classify({ mode: 'report', report_kind: 'brief' }), { category: 'reports', feature: 'report_interim' });
  });

  it('classifies a final report', () => {
    assert.deepEqual(classify({ mode: 'report', report_kind: 'final' }), { category: 'reports', feature: 'report_final' });
  });

  it('classifies the decision output', () => {
    assert.deepEqual(classify({ mode: 'decision' }), { category: 'reports', feature: 'decision' });
  });

  describe('autopilot', () => {
    it('classifies as question discussion when question_id is present', () => {
      assert.deepEqual(classify({ mode: 'autopilot', question_id: '7' }), { category: 'question_resolution', feature: 'question_discussion' });
    });

    it('treats question_id 0 as present (boundary: falsy but not empty)', () => {
      assert.deepEqual(classify({ mode: 'autopilot', question_id: 0 }), { category: 'question_resolution', feature: 'question_discussion' });
    });

    it('does not treat an empty-string question_id as present', () => {
      assert.deepEqual(classify({ mode: 'autopilot', question_id: '' }), { category: 'autopilot', feature: 'autopilot' });
    });

    it('classifies as question discussion via autopilot_scope alone, with no question_id', () => {
      assert.deepEqual(classify({ mode: 'autopilot', autopilot_scope: 'question' }), { category: 'question_resolution', feature: 'question_discussion' });
    });

    it('classifies as disagreement autopilot when disagreement_n is present', () => {
      assert.deepEqual(classify({ mode: 'autopilot', disagreement_n: 2 }), { category: 'disagreement_resolution', feature: 'disagreement_autopilot' });
    });

    it('treats disagreement_n 0 as present (boundary)', () => {
      assert.deepEqual(classify({ mode: 'autopilot', disagreement_n: 0 }), { category: 'disagreement_resolution', feature: 'disagreement_autopilot' });
    });

    it('classifies as disagreement autopilot via autopilot_scope alone', () => {
      assert.deepEqual(classify({ mode: 'autopilot', autopilot_scope: 'disagreement' }), { category: 'disagreement_resolution', feature: 'disagreement_autopilot' });
    });

    it('prefers question_id over disagreement_n when both are present', () => {
      assert.deepEqual(
        classify({ mode: 'autopilot', question_id: '7', disagreement_n: 2 }),
        { category: 'question_resolution', feature: 'question_discussion' },
      );
    });

    it('falls back to plain autopilot discussion when neither is scoped', () => {
      assert.deepEqual(classify({ mode: 'autopilot' }), { category: 'autopilot', feature: 'autopilot' });
    });
  });

  describe('agent presentation modes', () => {
    for (const mode of ['opening', 'round2', 'round3', 'crosstalk', 'reply', 'dive_deeper']) {
      it(`classifies "${mode}" as agent_presentation/${mode}`, () => {
        assert.deepEqual(classify({ mode }), { category: 'agent_presentation', feature: mode });
      });
    }

    it('classifies a plain custom meeting as agent_presentation/custom', () => {
      assert.deepEqual(classify({ mode: 'custom' }), { category: 'agent_presentation', feature: 'custom' });
    });

    it('classifies a custom meeting scoped to a disagreement as disagreement_discussion', () => {
      assert.deepEqual(classify({ mode: 'custom', disagreement_n: 4 }), { category: 'disagreement_resolution', feature: 'disagreement_discussion' });
    });

    it('treats disagreement_n 0 on a custom meeting as present (boundary)', () => {
      assert.deepEqual(classify({ mode: 'custom', disagreement_n: 0 }), { category: 'disagreement_resolution', feature: 'disagreement_discussion' });
    });
  });

  it('classifies an unrecognised mode as "other", keeping the mode as the feature', () => {
    assert.deepEqual(classify({ mode: 'bogus-future-mode' }), { category: 'other', feature: 'bogus-future-mode' });
  });

  it('classifies a missing mode as other/unknown', () => {
    assert.deepEqual(classify({}), { category: 'other', feature: 'unknown' });
  });

  it('classifies no arguments at all as other/unknown', () => {
    assert.deepEqual(classify(), { category: 'other', feature: 'unknown' });
  });

  it('classifies a null mode as other/unknown', () => {
    assert.deepEqual(classify({ mode: null }), { category: 'other', feature: 'unknown' });
  });
});

describe('summarise', () => {
  const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

  it('returns all-zero totals for a session with nothing recorded', () => {
    const out = summarise({ calls: [], messages: [], reports: [], autopilotRuns: [] });
    assert.deepEqual(out.total, { cost_usd: 0, calls: 0, failed_calls: 0, requests: 0, input_tokens: 0, output_tokens: 0, searches: 0 });
    assert.equal(out.call_count, 0);
    assert.equal(out.legacy_calls, 0);
    assert.equal(out.ledger_available, true);
    assert.deepEqual(out.by_category, []);
    assert.deepEqual(out.by_model, []);
    assert.deepEqual(out.by_agent, []);
    assert.deepEqual(out.calls, []);
  });

  it('defaults messages/reports/autopilotRuns to empty when omitted', () => {
    const out = summarise({ calls: [] });
    assert.equal(out.call_count, 0);
  });

  it('reports ledger_available: false when calls is null (table missing)', () => {
    const out = summarise({ calls: null, messages: [], reports: [] });
    assert.equal(out.ledger_available, false);
    assert.equal(out.call_count, 0);
  });

  it('ledger_available is true for an empty array (table exists, nothing logged yet)', () => {
    const out = summarise({ calls: [], messages: [], reports: [] });
    assert.equal(out.ledger_available, true);
  });

  describe('Final report dedupe: counted exactly once across every ledger/legacy combination', () => {
    it('ledger row keyed by report_id wins over the transcript copy of the same report', () => {
      const calls = [{
        id: 1, session_id: 1, category: 'reports', feature: 'report_final', speaker: 'moderator', model: 'x',
        message_id: null, report_id: 5, requests: 1, input_tokens: 100, output_tokens: 200, searches: 0,
        cost_usd: 1.5, duration_ms: 1000, error: null, created_at: '2024-01-01T00:00:00Z',
      }];
      const messages = [{
        id: 10, role: 'moderator', speaker: 'moderator', mode: 'decision', cost_usd: 1.5, input_tokens: 100, output_tokens: 200,
        error: null, content_json: JSON.stringify({ report_id: 5, model: 'x', usage: { requests: 1 } }), created_at: '2024-01-01T00:00:01Z',
      }];
      const reports = [{ id: 5, kind: 'final', cost_usd: 1.5, model: 'x', created_at: '2024-01-01T00:00:00Z' }];

      const out = summarise({ calls, messages, reports });

      assert.equal(out.call_count, 1, 'the transcript copy and the report row must not add two more rows on top of the ledger row');
      assert.equal(out.legacy_calls, 0);
      assert.equal(out.total.cost_usd, 1.5);
    });

    it('no ledger row: the transcript message is counted, and the matching report row is then skipped', () => {
      const messages = [{
        id: 10, role: 'moderator', speaker: 'moderator', mode: 'decision', cost_usd: 1.5, input_tokens: 100, output_tokens: 200,
        error: null, content_json: JSON.stringify({ report_id: 5, model: 'x' }), created_at: '2024-01-01T00:00:01Z',
      }];
      const reports = [{ id: 5, kind: 'final', cost_usd: 1.5, model: 'x', created_at: '2024-01-01T00:00:00Z' }];

      const out = summarise({ calls: null, messages, reports });

      assert.equal(out.call_count, 1);
      assert.equal(out.legacy_calls, 1);
      assert.equal(out.total.cost_usd, 1.5);
      assert.equal(out.calls[0].report_id, undefined, 'came from the message, not legacyCallFromReport');
      assert.equal(out.calls[0].message_id, 10);
      assert.equal(out.calls[0].feature, 'report_final', "the copy's mode is 'decision', but it is a Final report");
    });

    it('no ledger row, no transcript copy (older export): the report row alone is counted', () => {
      const reports = [{ id: 5, kind: 'final', cost_usd: 1.5, model: 'x', created_at: '2024-01-01T00:00:00Z' }];

      const out = summarise({ calls: null, messages: [], reports });

      assert.equal(out.call_count, 1);
      assert.equal(out.calls[0].report_id, 5);
      assert.equal(out.calls[0].category, 'reports');
      assert.equal(out.calls[0].feature, 'report_final');
    });

    it('a zero-cost report row is never counted, ledger or not', () => {
      const reports = [{ id: 5, kind: 'final', cost_usd: 0, model: 'x', created_at: '2024-01-01T00:00:00Z' }];
      const out = summarise({ calls: null, messages: [], reports });
      assert.equal(out.call_count, 0);
    });
  });

  it('excludes a zero-cost, no-error message (a plain human or system note)', () => {
    const messages = [{
      id: 1, role: 'user', speaker: 'user', mode: 'reply', cost_usd: 0, input_tokens: 0, output_tokens: 0,
      error: null, content_json: null, created_at: '2024-01-01T00:00:00Z',
    }];
    const out = summarise({ calls: null, messages, reports: [] });
    assert.equal(out.call_count, 0);
  });

  it('includes a failed agent turn even at zero cost', () => {
    const messages = [{
      id: 2, role: 'agent', speaker: 'clinical', mode: 'opening', cost_usd: 0, input_tokens: 0, output_tokens: 0,
      error: 'OpenRouter HTTP 500', content_json: null, created_at: '2024-01-01T00:00:00Z',
    }];
    const out = summarise({ calls: null, messages, reports: [] });
    assert.equal(out.call_count, 1);
    assert.equal(out.total.failed_calls, 1);
    assert.equal(out.calls[0].category, 'agent_presentation');
    assert.equal(out.calls[0].feature, 'opening');
    assert.equal(out.calls[0].error, 'OpenRouter HTTP 500');
  });

  it('excludes a zero-cost errored system message (system/user rows never count, even with an error)', () => {
    const messages = [{
      id: 3, role: 'system', speaker: 'system', mode: 'system', cost_usd: 0, input_tokens: 0, output_tokens: 0,
      error: 'some system note error', content_json: null, created_at: '2024-01-01T00:00:00Z',
    }];
    const out = summarise({ calls: null, messages, reports: [] });
    assert.equal(out.call_count, 0);
  });

  it('tolerates unparsable content_json on a legacy message instead of throwing', () => {
    const messages = [{
      id: 4, role: 'agent', speaker: 'clinical', mode: 'opening', cost_usd: 0.02, input_tokens: 10, output_tokens: 20,
      error: null, content_json: '{not valid json', created_at: '2024-01-01T00:00:00Z',
    }];
    const out = summarise({ calls: null, messages, reports: [] });
    assert.equal(out.call_count, 1);
    assert.equal(out.calls[0].cost_usd, 0.02);
  });

  describe('autopilot legacy classification (content_json.autopilot + autopilot_runs)', () => {
    const baseMsg = (overrides) => ({
      id: 20, role: 'agent', speaker: 'commercial', mode: 'autopilot', cost_usd: 0.05, input_tokens: 10, output_tokens: 10,
      error: null, created_at: '2024-01-01T00:00:00Z', ...overrides,
    });

    it('classifies via the run\'s scope: disagreement', () => {
      const messages = [baseMsg({ content_json: JSON.stringify({ autopilot: { run_id: 9 }, model: 'm' }) })];
      const autopilotRuns = [{ id: 9, scope: 'disagreement', disagreement_n: 3 }];
      const out = summarise({ calls: null, messages, reports: [], autopilotRuns });
      assert.equal(out.calls[0].category, 'disagreement_resolution');
      assert.equal(out.calls[0].feature, 'disagreement_autopilot');
    });

    it('classifies via the run\'s scope: question', () => {
      const messages = [baseMsg({ content_json: JSON.stringify({ autopilot: { run_id: 9 }, model: 'm' }) })];
      const autopilotRuns = [{ id: 9, scope: 'question' }];
      const out = summarise({ calls: null, messages, reports: [], autopilotRuns });
      assert.equal(out.calls[0].category, 'question_resolution');
      assert.equal(out.calls[0].feature, 'question_discussion');
    });

    it('classifies via content_json.autopilot.question_id directly, without a run', () => {
      const messages = [baseMsg({ content_json: JSON.stringify({ autopilot: { question_id: '11' }, model: 'm' }) })];
      const out = summarise({ calls: null, messages, reports: [], autopilotRuns: [] });
      assert.equal(out.calls[0].category, 'question_resolution');
      assert.equal(out.calls[0].feature, 'question_discussion');
    });

    it('falls back to plain autopilot when run_id points at no known run', () => {
      const messages = [baseMsg({ content_json: JSON.stringify({ autopilot: { run_id: 999 }, model: 'm' }) })];
      const out = summarise({ calls: null, messages, reports: [], autopilotRuns: [{ id: 9, scope: 'disagreement', disagreement_n: 3 }] });
      assert.equal(out.calls[0].category, 'autopilot');
      assert.equal(out.calls[0].feature, 'autopilot');
    });

    it('falls back to plain autopilot when content_json has no autopilot block at all', () => {
      const messages = [baseMsg({ content_json: JSON.stringify({ model: 'm' }) })];
      const out = summarise({ calls: null, messages, reports: [], autopilotRuns: [] });
      assert.equal(out.calls[0].category, 'autopilot');
      assert.equal(out.calls[0].feature, 'autopilot');
    });
  });

  it('a message already in the ledger by message_id is not counted again as legacy', () => {
    const calls = [{
      id: 1, session_id: 1, category: 'agent_presentation', feature: 'opening', speaker: 'clinical', model: 'm',
      message_id: 42, report_id: null, requests: 1, input_tokens: 5, output_tokens: 5, searches: 0,
      cost_usd: 0.01, duration_ms: 100, error: null, created_at: '2024-01-01T00:00:00Z',
    }];
    const messages = [{
      id: 42, role: 'agent', speaker: 'clinical', mode: 'opening', cost_usd: 0.01, input_tokens: 5, output_tokens: 5,
      error: null, content_json: null, created_at: '2024-01-01T00:00:00Z',
    }];
    const out = summarise({ calls, messages, reports: [] });
    assert.equal(out.call_count, 1);
    assert.equal(out.legacy_calls, 0);
  });

  it('defaults an unknown model to "unknown" and an unknown speaker to "unknown" for grouping', () => {
    const calls = [{
      id: 1, session_id: 1, category: 'other', feature: 'x', speaker: null, model: null,
      message_id: null, report_id: null, requests: 0, input_tokens: 0, output_tokens: 0, searches: 0,
      cost_usd: 0.01, duration_ms: null, error: null, created_at: '2024-01-01T00:00:00Z',
    }];
    const out = summarise({ calls, messages: [], reports: [] });
    assert.equal(out.calls[0].model, 'unknown');
    assert.equal(out.by_model[0].key, 'unknown');
    assert.equal(out.by_agent[0].key, 'unknown');
  });

  it('remaps an unrecognised stored category to "other" rather than dropping the row', () => {
    const calls = [{
      id: 1, session_id: 1, category: 'some_future_category', feature: 'z', speaker: 'clinical', model: 'm',
      message_id: null, report_id: null, requests: 0, input_tokens: 0, output_tokens: 0, searches: 0,
      cost_usd: 0.01, duration_ms: null, error: null, created_at: '2024-01-01T00:00:00Z',
    }];
    const out = summarise({ calls, messages: [], reports: [] });
    assert.equal(out.calls[0].category, 'other');
    assert.equal(out.calls[0].category_label, 'Other');
    assert.equal(out.call_count, 1, 'a call with an unrecognised category is still counted, not silently dropped');
  });

  it('falls back to the raw feature key as the label when it has no FEATURE_LABEL entry', () => {
    const calls = [{
      id: 1, session_id: 1, category: 'other', feature: 'some_future_feature', speaker: 'clinical', model: 'm',
      message_id: null, report_id: null, requests: 0, input_tokens: 0, output_tokens: 0, searches: 0,
      cost_usd: 0.01, duration_ms: null, error: null, created_at: '2024-01-01T00:00:00Z',
    }];
    const out = summarise({ calls, messages: [], reports: [] });
    assert.equal(out.calls[0].feature_label, 'some_future_feature');
    assert.equal(FEATURE_LABEL.some_future_feature, undefined, 'sanity: this key really is unrecognised');
  });

  it('sums totals, and failed_calls counts only rows with an error', () => {
    const calls = [
      { id: 1, session_id: 1, category: 'agent_presentation', feature: 'opening', speaker: 'clinical', model: 'm', message_id: 1, report_id: null, requests: 1, input_tokens: 10, output_tokens: 20, searches: 1, cost_usd: 0.10, duration_ms: 100, error: null, created_at: '2024-01-01T00:00:00Z' },
      { id: 2, session_id: 1, category: 'agent_presentation', feature: 'round2', speaker: 'commercial', model: 'm', message_id: 2, report_id: null, requests: 2, input_tokens: 30, output_tokens: 40, searches: 0, cost_usd: 0.20, duration_ms: 200, error: 'timeout', created_at: '2024-01-01T00:00:01Z' },
    ];
    const out = summarise({ calls, messages: [], reports: [] });
    assert.ok(Math.abs(out.total.cost_usd - 0.30) < 1e-9);
    assert.equal(out.total.calls, 2);
    assert.equal(out.total.failed_calls, 1);
    assert.equal(out.total.requests, 3);
    assert.equal(out.total.input_tokens, 40);
    assert.equal(out.total.output_tokens, 60);
    assert.equal(out.total.searches, 1);
  });

  it('groups by_category with nested features, sorted by cost descending', () => {
    const calls = [
      { id: 1, session_id: 1, category: 'agent_presentation', feature: 'opening', speaker: 'clinical', model: 'm', message_id: 1, report_id: null, requests: 1, input_tokens: 1, output_tokens: 1, searches: 0, cost_usd: 0.05, duration_ms: 1, error: null, created_at: '2024-01-01T00:00:00Z' },
      { id: 2, session_id: 1, category: 'reports', feature: 'decision', speaker: 'moderator', model: 'm', message_id: 2, report_id: null, requests: 1, input_tokens: 1, output_tokens: 1, searches: 0, cost_usd: 1.00, duration_ms: 1, error: null, created_at: '2024-01-01T00:00:01Z' },
    ];
    const out = summarise({ calls, messages: [], reports: [] });
    assert.equal(out.by_category.length, 2);
    assert.equal(out.by_category[0].key, 'reports', 'higher-cost category sorts first');
    assert.equal(out.by_category[0].label, CATEGORY_LABEL.reports);
    assert.equal(out.by_category[0].features[0].key, 'decision');
    assert.equal(out.by_category[1].key, 'agent_presentation');
    assert.equal(out.by_category[1].features[0].key, 'opening');
  });

  it('breaks a cost tie in grouping by the higher call count', () => {
    const calls = [
      { id: 1, session_id: 1, category: 'agent_presentation', feature: 'opening', speaker: 'clinical', model: 'm', message_id: 1, report_id: null, requests: 0, input_tokens: 0, output_tokens: 0, searches: 0, cost_usd: 0.25, duration_ms: 1, error: null, created_at: '2024-01-01T00:00:00Z' },
      { id: 2, session_id: 1, category: 'agent_presentation', feature: 'round2', speaker: 'clinical', model: 'm', message_id: 2, report_id: null, requests: 0, input_tokens: 0, output_tokens: 0, searches: 0, cost_usd: 0.25, duration_ms: 1, error: null, created_at: '2024-01-01T00:00:01Z' },
      { id: 3, session_id: 1, category: 'reports', feature: 'decision', speaker: 'moderator', model: 'm', message_id: 3, report_id: null, requests: 0, input_tokens: 0, output_tokens: 0, searches: 0, cost_usd: 0.50, duration_ms: 1, error: null, created_at: '2024-01-01T00:00:02Z' },
    ];
    const out = summarise({ calls, messages: [], reports: [] });
    // agent_presentation totals 0.50 across 2 calls; reports totals 0.50 across 1 call — tie on cost.
    assert.equal(out.by_category[0].key, 'agent_presentation', 'same total cost, but more calls sorts first');
    assert.equal(out.by_category[0].calls, 2);
    assert.equal(out.by_category[1].key, 'reports');
  });

  it('orders recent calls newest first and truncates to recentLimit', () => {
    const mk = (id, iso) => ({
      id, session_id: 1, category: 'other', feature: 'x', speaker: 'clinical', model: 'm', message_id: id, report_id: null,
      requests: 0, input_tokens: 0, output_tokens: 0, searches: 0, cost_usd: 0.01, duration_ms: 1, error: null, created_at: iso,
    });
    const calls = [mk(1, '2024-01-01T00:00:00Z'), mk(2, '2024-01-03T00:00:00Z'), mk(3, '2024-01-02T00:00:00Z')];
    const out = summarise({ calls, messages: [], reports: [], recentLimit: 2 });
    assert.equal(out.calls.length, 2);
    assert.equal(out.calls[0].id, 2);
    assert.equal(out.calls[1].id, 3);
    assert.equal(out.call_count, 3, 'call_count is the true total, unaffected by recentLimit');
  });

  it('sorts a call with an unparsable created_at to the end, instead of throwing', () => {
    const calls = [
      { id: 1, session_id: 1, category: 'other', feature: 'x', speaker: 'clinical', model: 'm', message_id: 1, report_id: null, requests: 0, input_tokens: 0, output_tokens: 0, searches: 0, cost_usd: 0.01, duration_ms: 1, error: null, created_at: 'not-a-date' },
      { id: 2, session_id: 1, category: 'other', feature: 'x', speaker: 'clinical', model: 'm', message_id: 2, report_id: null, requests: 0, input_tokens: 0, output_tokens: 0, searches: 0, cost_usd: 0.01, duration_ms: 1, error: null, created_at: '2024-01-01T00:00:00Z' },
    ];
    const out = summarise({ calls, messages: [], reports: [] });
    assert.equal(out.calls[0].id, 2);
    assert.equal(out.calls[1].id, 1);
  });

  it('accepts a Date object for created_at as well as a string (node-pg vs. test fixtures)', () => {
    const calls = [
      { id: 1, session_id: 1, category: 'other', feature: 'x', speaker: 'clinical', model: 'm', message_id: 1, report_id: null, requests: 0, input_tokens: 0, output_tokens: 0, searches: 0, cost_usd: 0.01, duration_ms: 1, error: null, created_at: new Date('2024-01-01T00:00:00Z') },
      { id: 2, session_id: 1, category: 'other', feature: 'x', speaker: 'clinical', model: 'm', message_id: 2, report_id: null, requests: 0, input_tokens: 0, output_tokens: 0, searches: 0, cost_usd: 0.01, duration_ms: 1, error: null, created_at: new Date('2024-01-02T00:00:00Z') },
    ];
    const out = summarise({ calls, messages: [], reports: [] });
    assert.equal(out.calls[0].id, 2);
  });
});
