'use strict';
// src/db.js's mergeSourceKind: a source's kind only ever moves towards
// 'cited', never back. Pure and exported for exactly this reason.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mergeSourceKind } = require('../src/db');

describe('mergeSourceKind', () => {
  it('returns the same kind when both sides agree', () => {
    assert.equal(mergeSourceKind('searched', 'searched'), 'searched');
    assert.equal(mergeSourceKind('cited', 'cited'), 'cited');
  });

  it('"cited" wins over anything else, on either side', () => {
    assert.equal(mergeSourceKind('searched', 'cited'), 'cited');
    assert.equal(mergeSourceKind('cited', 'searched'), 'cited');
    assert.equal(mergeSourceKind('unverified', 'cited'), 'cited');
    assert.equal(mergeSourceKind('cited', 'unverified'), 'cited');
  });

  it('"searched" + "unverified" (either order) becomes "cited": a URL cited while unseen that later turns up in a search is real', () => {
    assert.equal(mergeSourceKind('searched', 'unverified'), 'cited');
    assert.equal(mergeSourceKind('unverified', 'searched'), 'cited');
  });

  it('falls back to whichever side is truthy when neither of the above applies', () => {
    assert.equal(mergeSourceKind('unverified', 'unverified'), 'unverified');
    assert.equal(mergeSourceKind(null, 'searched'), 'searched');
    assert.equal(mergeSourceKind('searched', null), 'searched');
  });
});
