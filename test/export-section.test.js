'use strict';
// src/export.js's new single-tab path: singleDoc()/opts.section, shared with
// the existing opts.report path, plus the new sectionFileName(). Real docx/
// pdfmake — this asserts on the actual bytes produced (magic numbers, and for
// docx the real word/document.xml text via jszip, a transitive dependency of
// the docx package already present in node_modules), not just "did not throw".
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { toDocx, toPdf, sectionFileName, fileName } = require('../src/export');

function baseSession(overrides = {}) {
  return {
    id: 39,
    title: 'Anatop · Argentina',
    product: 'Anatop',
    country: 'Argentina',
    inputs: { product: 'Anatop', country: 'Argentina' },
    messages: [],
    sources: [],
    disagreements: [],
    autopilot_runs: [],
    reports: [],
    ...overrides,
  };
}

async function docxText(buf) {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml').async('string');
  // Strip tags to get the plain reading-order text, good enough to assert on.
  return xml.replace(/<[^>]+>/g, ' ');
}

describe('sectionFileName()', () => {
  it('joins the session file name and the section key', () => {
    const s = baseSession({ title: 'Anatop Argentina Launch' });
    assert.equal(sectionFileName(s, 'sources'), `${fileName(s)}_sources`);
  });

  it('truncates to 100 characters for a very long title', () => {
    const s = baseSession({ title: 'X'.repeat(200) });
    const out = sectionFileName(s, 'disagreements');
    assert.ok(out.length <= 100, `expected <= 100 chars, got ${out.length}`);
  });
});

describe('toDocx(s, { section })', () => {
  it('produces a real zip (docx magic bytes "PK") whose body carries the section title and markdown', async () => {
    const s = baseSession();
    const section = { key: 'sources', title: 'Sources', markdown: '## Heading\n\nA distinctive paragraph MARKERTEXTABC.' };

    const buf = await toDocx(s, { section });

    assert.equal(buf.slice(0, 2).toString('latin1'), 'PK', 'docx is a zip archive');
    const text = await docxText(buf);
    assert.match(text, /Sources/);
    assert.match(text, /MARKERTEXTABC/);
  });

  it('omits the "About this report" block for a section export (only reports get one)', async () => {
    const s = baseSession();
    const section = { key: 'inputs', title: 'Inputs', markdown: 'Body.' };

    const buf = await toDocx(s, { section });

    const text = await docxText(buf);
    assert.doesNotMatch(text, /About this report/);
  });
});

describe('toDocx(s, { report }) — regression: still produces "About this report"', () => {
  it('includes the About this report block with the rounds summary, model and cost', async () => {
    const s = baseSession({
      messages: [{ mode: 'opening', role: 'agent', speaker: 'clinical' }, { mode: 'round2', role: 'agent', speaker: 'commercial' }],
      autopilot_runs: [{ id: 1 }],
    });
    const report = { kind: 'final', depth: 'full', created_by: 'a@b.com', text: 'Report body MARKER.', model: 'gpt-test', cost_usd: 1.5 };

    const buf = await toDocx(s, { report });

    const text = await docxText(buf);
    assert.match(text, /About this report/);
    assert.match(text, /Report body MARKER\./);
    assert.match(text, /model: gpt-test/);
    assert.match(text, /cost: \$1\.500/);
    assert.match(text, /Round 1/, 'rounds actually run are named in the summary line');
    assert.match(text, /Round 2/);
    assert.match(text, /1 autopilot run\(s\)/);
  });

  it('reports "none run yet" when no rounds and no autopilot runs have happened', async () => {
    const s = baseSession();
    const report = { kind: 'interim', depth: 'brief', created_by: null, text: 'Body.', model: null, cost_usd: 0 };

    const buf = await toDocx(s, { report });

    const text = await docxText(buf);
    assert.match(text, /none run yet/);
    assert.match(text, /model: n\/a/);
    assert.match(text, /unattributed/, 'no created_by falls back to "unattributed" as the byline');
  });
});

describe('toPdf(s, { section }) and toPdf(s, { report })', () => {
  it('produces a real PDF (magic bytes "%PDF") for a section export', async () => {
    const s = baseSession();
    const section = { key: 'minutes', title: 'Minutes', markdown: 'Some minutes body.' };

    const buf = await toPdf(s, { section });

    assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-');
  });

  it('produces a real PDF for a report export', async () => {
    const s = baseSession();
    const report = { kind: 'final', depth: 'standard', created_by: 'x@y.com', text: 'Report body.', model: 'gpt-test', cost_usd: 0.2 };

    const buf = await toPdf(s, { report });

    assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-');
  });
});

describe('toDocx/toPdf with neither opts.report nor opts.section — the full-session path is unaffected', () => {
  it('still builds a full session document with no section/report options', async () => {
    const s = baseSession({ decision_text: 'Go.' });

    const docxBuf = await toDocx(s, {});
    const pdfBuf = await toPdf(s, {});

    assert.equal(docxBuf.slice(0, 2).toString('latin1'), 'PK');
    assert.equal(pdfBuf.slice(0, 5).toString('latin1'), '%PDF-');
  });
});
