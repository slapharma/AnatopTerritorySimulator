'use strict';
// renderKnowledge (web/app.js): the knowledgebase tab, moved from Admin into
// every evaluation's Intelligence sidebar. Anyone can read it; only admins get
// the add/edit form and the per-row Edit/Delete actions. As in the other
// web/app.js vm tests, renderKnowledge is sliced out by string markers and run
// in a vm context. A second, separate slice covers the export menu's
// NO_TAB_EXPORT behaviour (hiding "This tab" export links for the shared
// knowledgebase tab, which has no per-evaluation export).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');

// Enough of a fake node for renderKnowledge to wire its form/row handlers
// without throwing: a settable innerHTML, and a memoized querySelector(All)
// so a selector asked for twice on the same element returns the same node
// (matching the real DOM, and letting a test read state set on it).
class FakeElement {
  constructor() { this._html = ''; this.textContent = ''; this._subEls = {}; }

  get innerHTML() { return this._html; }

  set innerHTML(v) { this._html = v; this._subEls = {}; }

  querySelector(sel) {
    if (!(sel in this._subEls)) this._subEls[sel] = new FakeElement();
    return this._subEls[sel];
  }

  querySelectorAll() { return []; }

  addEventListener(type, fn) { if (type === 'submit' || type === 'click') this[`_${type}`] = fn; }

  closest() { return { dataset: {} }; }
}

function loadRenderKnowledge({ knowledge, knowledgeError, me, kbEditId } = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf('  // ---------------- knowledgebase ----------------');
  const end = src.indexOf('  // Splits the stored ⚠ DISAGREEMENT block');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did the knowledgebase section move?');

  const elements = { '#tab-knowledgebase': new FakeElement(), '#count-knowledge': new FakeElement() };
  const ctx = {
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    state: { knowledge, knowledgeError, me, kbEditId },
    $: (sel, root) => (root ? root.querySelector(sel) : (elements[sel] || null)),
    $$: (sel, root) => (root ? root.querySelectorAll(sel) : []),
    api: { get: async () => knowledge, send: async () => ({}) },
    toast: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\nthis.renderKnowledge = renderKnowledge;`, ctx);
  ctx.elements = elements;
  return ctx;
}

const item = (over = {}) => ({ id: 1, category: 'Regulatory', title: 'ANMAT guidance', url: 'https://example.com/a', note: 'Read first', sensitive: false, ...over });

describe('web/app.js renderKnowledge — admin', () => {
  it('shows #kb-form first in #tab-knowledgebase, then Edit/Delete per row', () => {
    const ctx = loadRenderKnowledge({ knowledge: [item()], me: { authenticated: true, is_admin: true } });

    ctx.renderKnowledge();

    const html = ctx.elements['#tab-knowledgebase'].innerHTML;
    const formIdx = html.indexOf('id="kb-form"');
    const rowIdx = html.indexOf('data-id="1"');
    assert.ok(formIdx >= 0, '#kb-form is present');
    assert.ok(rowIdx > formIdx, '#kb-form comes before the table rows');
    assert.match(html, /data-kb="edit">Edit</);
    assert.match(html, /data-kb="delete">Delete</);
  });

  it('treats an unauthenticated visitor (no-auth-configured mode) as admin as well', () => {
    const ctx = loadRenderKnowledge({ knowledge: [item()], me: { authenticated: false } });

    ctx.renderKnowledge();

    assert.match(ctx.elements['#tab-knowledgebase'].innerHTML, /id="kb-form"/);
  });

  it('shows no form when /api/me failed to load, even though authenticated reads false', () => {
    const ctx = loadRenderKnowledge({ knowledge: [item()], me: { failed: true, authenticated: false } });

    ctx.renderKnowledge();

    assert.doesNotMatch(ctx.elements['#tab-knowledgebase'].innerHTML, /id="kb-form"/);
  });

  it('shows no form when state.me was never set (no /api/me response yet)', () => {
    const ctx = loadRenderKnowledge({ knowledge: [item()], me: undefined });

    ctx.renderKnowledge();

    assert.doesNotMatch(ctx.elements['#tab-knowledgebase'].innerHTML, /id="kb-form"/);
  });

  it('sets the tab count to the number of items', () => {
    const ctx = loadRenderKnowledge({ knowledge: [item({ id: 1 }), item({ id: 2 })], me: { authenticated: true, is_admin: true } });

    ctx.renderKnowledge();

    assert.equal(ctx.elements['#count-knowledge'].textContent, 2);
  });
});

describe('web/app.js renderKnowledge — non-admin', () => {
  it('shows no form and no per-row actions for an authenticated, non-admin user', () => {
    const ctx = loadRenderKnowledge({ knowledge: [item()], me: { authenticated: true, is_admin: false } });

    ctx.renderKnowledge();

    const html = ctx.elements['#tab-knowledgebase'].innerHTML;
    assert.doesNotMatch(html, /id="kb-form"/);
    assert.doesNotMatch(html, /data-kb="edit"/);
    assert.doesNotMatch(html, /data-kb="delete"/);
    assert.match(html, /Only admins can add or change knowledgebase sources\./);
  });

  it('still sets the count for a non-admin', () => {
    const ctx = loadRenderKnowledge({ knowledge: [item()], me: { authenticated: true, is_admin: false } });

    ctx.renderKnowledge();

    assert.equal(ctx.elements['#count-knowledge'].textContent, 1);
  });
});

describe('web/app.js renderKnowledge — loading / error states', () => {
  it('shows a loading message and a "0" count while state.knowledge is null with no error yet', () => {
    const ctx = loadRenderKnowledge({ knowledge: null, me: { authenticated: true, is_admin: true } });

    ctx.renderKnowledge();

    assert.match(ctx.elements['#tab-knowledgebase'].innerHTML, /Loading the knowledgebase…/);
    assert.equal(ctx.elements['#count-knowledge'].textContent, '0');
  });

  it('shows the error message when state.knowledge is null and knowledgeError is set', () => {
    const ctx = loadRenderKnowledge({ knowledge: null, knowledgeError: 'Network error', me: { authenticated: true, is_admin: true } });

    ctx.renderKnowledge();

    assert.match(ctx.elements['#tab-knowledgebase'].innerHTML, /Could not load the knowledgebase: Network error/);
  });

  it('shows an empty-state message when the list loaded but has no items', () => {
    const ctx = loadRenderKnowledge({ knowledge: [], me: { authenticated: true, is_admin: true } });

    ctx.renderKnowledge();

    assert.match(ctx.elements['#tab-knowledgebase'].innerHTML, /No sources in the knowledgebase yet\./);
    assert.equal(ctx.elements['#count-knowledge'].textContent, 0);
  });
});

// ---------------- export menu: NO_TAB_EXPORT hides "This tab" links ----------------

function loadExportMenu({ activeTab }) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf('    // Export menu on the Intelligence page.');
  const end = src.indexOf('    // Intelligence page navigation in the sidebar.');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did the export menu block move?');
  const noTabExportStart = src.indexOf('  const NO_TAB_EXPORT = new Set');
  const noTabExportEnd = src.indexOf('\n', noTabExportStart) + 1;
  assert.ok(noTabExportStart >= 0, 'NO_TAB_EXPORT declaration not found');

  // #intel-export-menu starts hidden, as in the real markup, so opening it is
  // what drives the click handler's "if (open)" branch that fills the links.
  const elements = { '#intel-export-menu': { hidden: true, setAttribute() {}, addEventListener() {} } };
  const el = (sel) => {
    if (!(sel in elements)) elements[sel] = { hidden: false, textContent: '', href: '', setAttribute() {}, addEventListener(type, fn) { if (type === 'click') this._click = fn; } };
    return elements[sel];
  };
  const ctx = {
    INTEL_TITLE: { knowledgebase: 'Knowledgebase', sources: 'Sources' },
    state: { session: { id: 7 }, activeTab, intelCut: 'agent' },
    document: { addEventListener() {} },
    $: (sel) => el(sel),
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(noTabExportStart, noTabExportEnd)}\n${src.slice(start, end)}`, ctx);
  ctx.elements = elements;
  ctx.triggerExportClick = () => elements['#btn-intel-export']._click({ stopPropagation() {} });
  return ctx;
}

describe('web/app.js export menu — NO_TAB_EXPORT hides "This tab" links for knowledgebase', () => {
  it('hides the "This tab" export label/links/separator when the active tab is knowledgebase', () => {
    const ctx = loadExportMenu({ activeTab: 'knowledgebase' });

    ctx.triggerExportClick();

    assert.equal(ctx.elements['#intel-export-label'].hidden, true);
    assert.equal(ctx.elements['#link-intel-docx'].hidden, true);
    assert.equal(ctx.elements['#link-intel-pdf'].hidden, true);
    assert.equal(ctx.elements['#intel-export-menu .menu-sep'].hidden, true);
  });

  it('shows the "This tab" export links for an ordinary tab such as sources', () => {
    const ctx = loadExportMenu({ activeTab: 'sources' });

    ctx.triggerExportClick();

    assert.equal(ctx.elements['#intel-export-label'].hidden, false);
    assert.equal(ctx.elements['#link-intel-docx'].hidden, false);
    assert.equal(ctx.elements['#intel-export-menu .menu-sep'].hidden, false);
  });
});
