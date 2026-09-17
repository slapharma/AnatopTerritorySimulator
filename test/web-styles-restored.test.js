'use strict';
// 569b150 ("Side panel cleanup") deleted a whole block of web/styles.css and
// re-added only the .side-nav rules. Everything else in it was still in use:
// the left slide-over drawer (#nav-panel, opened by the header Admin/Agents/
// User Guide buttons) lost .panel/.panel-left/.panel.open, so it rendered as
// unstyled inline content at the foot of the page; every <dialog> lost its
// styling; and the Sources/Disagreements tabs, cost chip and LLM usage modal
// went bare. No test read the stylesheet, so nothing noticed. This parses
// web/styles.css and asserts those rules exist, at top level, with the
// declarations that make the drawer a drawer.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');

// Minimal CSS walker: comments stripped, then every `prelude { ... }` is
// recorded with its enclosing at-rules and its source position. Enough for a
// hand-written stylesheet with no strings containing braces.
function parseCss(text) {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const stack = [];
  let buf = '';
  let order = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      const prelude = buf.trim().replace(/\s+/g, ' ');
      buf = '';
      if (prelude.startsWith('@')) { stack.push(prelude); continue; }
      const close = css.indexOf('}', i);
      rules.push({
        selectors: prelude.split(',').map((s) => s.trim()),
        body: css.slice(i + 1, close).replace(/\s+/g, ' ').trim(),
        atRules: stack.slice(),
        order: order++,
      });
      i = close;
    } else if (ch === '}') {
      stack.pop();
      buf = '';
    } else {
      buf += ch;
    }
  }
  return rules;
}

const rules = parseCss(fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8'));
const topLevel = (sel) => rules.filter((r) => !r.atRules.length && r.selectors.includes(sel));
const bodyOf = (sel) => topLevel(sel).map((r) => r.body).join('; ');

describe('web/styles.css: rules lost in 569b150 are restored', () => {
  const required = [
    // slide-over drawer
    '.panel', '.panel.open', '.panel-left', '.panel-head', '.panel-head-actions', '.panel-title',
    '.panel-openfull', '.panel-openfull:hover', '.panel-frame', '.panel-close', '.panel-close:hover',
    '.count', '.tab-body',
    // Sources tab
    '.src', '.src .n', '.src a', '.src .meta', '.src .kind', '.src .kind.cited',
    // Disagreements tab
    '.dis', '.dis:hover', '.dis .topic', '.status', '.dis .status', '.status.unresolved', '.status.resolved',
    '.dis .body', '.dis-row', '.dis-row.dis-status-row', '.dis-label', '.dis-text', '.dis-back',
    // header cost chip, clock, model picker, empty states
    '.cost', 'button.cost', 'button.cost:hover', 'button.cost:focus-visible', '.active-clock', '.model-select', '.empty',
    // LLM usage modal
    '.usage-body', '.usage-body p', '.usage-tiles', '.usage-tile', '.usage-tile-label', '.usage-tile-value',
    '.usage-section h3', '.usage-pair', '.usage-scroll', '.usage-calls', '.usage-table', '.usage-table th',
    '.usage-table td', '.usage-table thead th', '.usage-table tbody th', '.usage-table .num', '.usage-table .nowrap',
    '.usage-table tr.usage-sub th', '.usage-table tr.usage-sub td', '.usage-table tr.usage-zero th',
    '.usage-table tr.usage-error td', '.usage-share', '.usage-bar', '.usage-bar > span', '.usage-pct', '.usage-failed',
    // dialogs
    'dialog', 'dialog::backdrop', '.dialog-form', '.dialog-form h2', '.dialog-form label', '.agent-picks',
    '.agent-picks legend', '.agent-picks label', '#dis-modal-status', '.dis-modal-body', '#dis-modal-back',
    '.dialog-actions', 'dialog.dlg-wide', '.msg-modal-body', '.msg-openfull',
  ];

  for (const sel of required) {
    it(`has a top-level rule for ${sel}`, () => {
      assert.ok(topLevel(sel).length > 0, `no top-level rule for "${sel}" in web/styles.css`);
    });
  }

  it('makes #nav-panel a fixed drawer hidden off the left edge until .open', () => {
    assert.match(bodyOf('.panel'), /position: ?fixed/);
    assert.match(bodyOf('.panel'), /transform: ?translateX\(100%\)/);
    assert.match(bodyOf('.panel-left'), /left: ?0/);
    assert.match(bodyOf('.panel-left'), /transform: ?translateX\(-100%\)/);
    assert.match(bodyOf('.panel.open'), /transform: ?translateX\(0\)/);
    assert.match(bodyOf('.panel-frame'), /flex: ?1/);
  });

  it('gives dialogs a backdrop and the usage modal a wide, scrolling body', () => {
    assert.match(bodyOf('dialog::backdrop'), /background:/);
    assert.match(bodyOf('dialog.dlg-wide'), /width:/);
    assert.match(bodyOf('.usage-body'), /overflow-y: ?auto/);
  });

  it('styles every class on the #nav-panel markup in web/index.html', () => {
    const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
    const aside = html.match(/<aside[^>]*id="nav-panel"[\s\S]*?<\/aside>/);
    assert.ok(aside, '#nav-panel <aside> not found in web/index.html');
    const classes = new Set([...aside[0].matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
    const escape = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const styled = (c) => rules.some((r) => r.selectors.some((s) => new RegExp(`\\.${escape(c)}(?![\\w-])`).test(s)));
    const bare = [...classes].filter((c) => !styled(c));
    assert.deepEqual(bare, [], `unstyled #nav-panel classes: ${bare.join(', ')}`);
  });

  // Cascade: a base rule placed after an equal-specificity override would
  // silently undo it. The narrow-screen full-width drawer is the one such pair.
  it('keeps the narrow-screen full-width .panel override after the base rule', () => {
    const base = topLevel('.panel')[0];
    const narrow = rules.find((r) => r.atRules.some((a) => /max-width: ?900px/.test(a)) && r.selectors.includes('.panel'));
    assert.ok(base && narrow, 'base .panel or @media (max-width: 900px) .panel rule missing');
    assert.ok(base.order < narrow.order, '@media .panel { width: 100vw } must come after the base .panel rule');
  });

  it('does not redefine rules the newer sidebar already owns, nor restore dead ones', () => {
    assert.equal(topLevel('.side-nav-item').length, 1, '.side-nav-item defined more than once');
    assert.equal(topLevel('.count.count-alert').length, 1, '.count.count-alert defined more than once');
    assert.equal(topLevel('.cost-table').length, 0, '.cost-table is dead: nothing renders it');
    assert.equal(topLevel('.side-nav-divider').length, 0, '.side-nav-divider is dead: nothing renders it');
  });
});
