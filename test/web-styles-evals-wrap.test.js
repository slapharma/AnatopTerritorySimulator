'use strict';
// The All evaluations table used to scroll sideways. The fix wraps cell text
// instead of forcing nowrap, and moves the "Meetings" cell's flex layout off
// the <td> itself onto an inner .evals-progress-cell div — a <td> that is
// itself display:flex breaks the row's shared bottom border with its table
// siblings. This locks both: no rule sets display:flex directly on a bare
// `.evals-table … td`, and the responsive card mode is driven by container
// queries against .evals-table-wrap, which must declare container-type.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const css = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Every `prelude { body }` with the at-rule it sits in ('' at top level).
function rules() {
  const out = [];
  const stack = [];
  let buf = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      const prelude = buf.trim().replace(/\s+/g, ' ');
      buf = '';
      if (prelude.startsWith('@')) { stack.push(prelude); continue; }
      const close = css.indexOf('}', i);
      out.push({ selectors: prelude.split(',').map((s) => s.trim()), body: css.slice(i + 1, close), at: stack.join(' ') });
      i = close;
    } else if (ch === '}') { stack.pop(); buf = ''; } else { buf += ch; }
  }
  return out;
}
const all = rules();
const decl = (sel, prop, at = '') => {
  const hits = all.filter((r) => r.at === at && r.selectors.includes(sel))
    .map((r) => (r.body.match(new RegExp(String.raw`(?:^|;)\s*${prop}\s*:\s*([^;]+)`)) || [])[1])
    .filter(Boolean);
  return hits.length ? hits[hits.length - 1].trim() : undefined;
};

describe('evals table no-horizontal-scroll layout', () => {
  it('.evals-table-wrap establishes a query container, for the card-mode @container rules to key off', () => {
    assert.equal(decl('.evals-table-wrap', 'container-type'), 'inline-size');
  });

  it('a card-mode @container rule exists, switching the table body to a stacked grid layout', () => {
    const cardRule = all.find((r) => r.at.includes('@container') && r.selectors.includes('.evals-table tbody tr') && /display\s*:\s*grid/.test(r.body));
    assert.ok(cardRule, 'expected an @container rule setting .evals-table tbody tr to display: grid');
  });

  it('no rule makes a bare <td> (or <th>) display:flex directly — that breaks the shared row border', () => {
    // The regression: display:flex was on the <td> itself for the Meetings
    // column. Layout must instead flex an inner wrapper div (.evals-progress-cell,
    // .evals-flags), never `td` / `th` element selectors themselves, outside the
    // stacked-card @container block where every cell intentionally becomes flex.
    const offenders = all.filter((r) => !r.at.includes('@container') && /display\s*:\s*flex/.test(r.body)
      && r.selectors.some((s) => /(^|\s)(td|th)(\.|:|\[|$|\s)/.test(s) && !/evals-progress-cell|evals-flags/.test(s)));
    assert.deepEqual(offenders.map((r) => r.selectors.join(', ')), []);
  });

  it('the header/data cell rule does not force nowrap — cells must be free to wrap onto multiple lines', () => {
    // decl() matches one selector of a list; the shared rule is found via .evals-table td.
    assert.ok(decl('.evals-table td', 'padding'), 'shared cell rule not found — the checks below would pass vacuously');
    assert.notEqual(decl('.evals-table td', 'white-space'), 'nowrap');
  });

  it('numeric cells and badges still keep nowrap, since those are short fixed-format values, not prose', () => {
    assert.equal(decl('.evals-table .num', 'white-space'), 'nowrap');
    assert.equal(decl('.evals-badge', 'white-space'), 'nowrap');
  });

  it('.evals-progress-cell and .evals-flags are the flex wrappers, declared as inline-block-free flex containers', () => {
    assert.equal(decl('.evals-progress-cell', 'display'), 'flex');
    assert.equal(decl('.evals-flags', 'display'), 'flex');
  });

  // A single long unbroken word (pasted URL, slash-joined title) otherwise sets
  // its column's minimum width and brings the sideways scroll back. Only
  // "anywhere" lowers that minimum; "break-word" does not.
  it('user-entered text (title, country, product) may break mid-word, but the shared cell rule may not', () => {
    for (const sel of ['.evals-open', '.evals-country', '.evals-product']) assert.equal(decl(sel, 'overflow-wrap'), 'anywhere', sel);
    assert.notEqual(decl('.evals-table td', 'overflow-wrap'), 'anywhere',
      'on every cell it splits headers and labels mid-word ("MEETIN/GS")');
  });
});
