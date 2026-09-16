'use strict';
// web/app.js is a browser IIFE, so (as in the other web/app.js vm tests)
// evaluate just meetingColumns() in a vm context against a minimal fake DOM.
//
// Bug: live turns of a standard meeting run for fewer than 3 agents (a
// resumed meeting, or a single Retry) rendered full-width below the grid
// instead of in their agent's column, because runSequence always built a
// brand-new grid instead of reusing the one already in the transcript.
// meetingColumns(t, mode, {fresh}) is the fix: it reuses the transcript's
// last .agent-grid when its data-mode matches and nothing follows it, and
// otherwise starts a fresh one.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const ALL = ['regulatory', 'clinical', 'commercial']; // Ruth, Luca, Charlie

// No DOM library is installed. This is the minimal fake element meetingColumns
// actually touches: classList.contains, dataset, appendChild/children,
// lastElementChild, and querySelector for the one selector shape it uses
// (':scope > .agent-col[data-speaker="x"]').
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this._classes = [];
    this.dataset = {};
    this.children = [];
  }

  get className() { return this._classes.join(' '); }

  set className(v) { this._classes = String(v).split(/\s+/).filter(Boolean); }

  get classList() {
    const self = this;
    return { contains: (c) => self._classes.includes(c) };
  }

  appendChild(el) { this.children.push(el); return el; }

  get lastElementChild() { return this.children.length ? this.children[this.children.length - 1] : null; }

  querySelector(sel) {
    const m = /^:scope > \.([\w-]+)\[data-speaker="([^"]+)"\]$/.exec(sel);
    if (!m) return null;
    const [, cls, speaker] = m;
    return this.children.find((c) => c._classes.includes(cls) && c.dataset.speaker === speaker) || null;
  }
}

function loadHelpers() {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf("  // The columns a live meeting's turns stream into, keyed by agent.");
  const end = src.indexOf('  async function runSequence(');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did meetingColumns move?');
  const ctx = { ALL, document: { createElement: (tag) => new FakeElement(tag) } };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\nthis.meetingColumns = meetingColumns;`, ctx);
  return ctx;
}

describe('web/app.js meetingColumns', () => {
  it('starts a new grid in an empty transcript, with columns keyed by every agent', () => {
    const { meetingColumns } = loadHelpers();
    const t = new FakeElement('div');

    const cols = meetingColumns(t, 'opening');

    assert.equal(t.children.length, 1, 'exactly one grid appended');
    const grid = t.children[0];
    assert.equal(grid.className, 'agent-grid');
    assert.equal(grid.dataset.mode, 'opening');
    for (const a of ALL) {
      assert.ok(grid.children.includes(cols[a]), `${a}'s column is in the grid`);
      assert.equal(cols[a].dataset.speaker, a);
      assert.equal(cols[a].className, `agent-col agent-col-${a}`);
    }
  });

  it('reuses the last grid when its mode matches and it is the last child', () => {
    const { meetingColumns } = loadHelpers();
    const t = new FakeElement('div');
    const first = meetingColumns(t, 'round2');

    const second = meetingColumns(t, 'round2');

    assert.equal(t.children.length, 1, 'no second grid appended');
    for (const a of ALL) assert.equal(second[a], first[a], `${a}'s column is the same element both times`);
  });

  it('starts a new grid when the last grid is a different mode', () => {
    const { meetingColumns } = loadHelpers();
    const t = new FakeElement('div');
    const first = meetingColumns(t, 'round2');

    const second = meetingColumns(t, 'round3');

    assert.equal(t.children.length, 2, 'a second grid was appended');
    assert.equal(t.children[1].dataset.mode, 'round3');
    for (const a of ALL) assert.notEqual(second[a], first[a]);
  });

  it('starts a new grid when something follows the last grid', () => {
    const { meetingColumns } = loadHelpers();
    const t = new FakeElement('div');
    const first = meetingColumns(t, 'round2');
    t.appendChild(new FakeElement('article')); // e.g. a live turn's own message element

    const second = meetingColumns(t, 'round2');

    assert.equal(t.children.length, 3, 'a fresh grid was appended after the intervening element');
    for (const a of ALL) assert.notEqual(second[a], first[a]);
  });

  it('fresh:true always starts a new grid, even when the last one matches', () => {
    const { meetingColumns } = loadHelpers();
    const t = new FakeElement('div');
    const first = meetingColumns(t, 'opening');

    const second = meetingColumns(t, 'opening', { fresh: true });

    assert.equal(t.children.length, 2);
    for (const a of ALL) assert.notEqual(second[a], first[a]);
  });
});
