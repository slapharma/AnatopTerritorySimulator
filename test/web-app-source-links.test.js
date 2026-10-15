'use strict';
// web/app.js: how a link an agent writes becomes a source link.
//   1. renderMarkdown marks every http(s) link a.src-link, and sets rel and
//      strips target itself rather than trusting the model's Markdown.
//   2. A document click on a.src-link inside a message opens the source modal
//      with the link's URL and the sentence around it; modifier and middle
//      clicks are left alone so they still open a new tab.
//   3. The copy-link button copies the modal's URL and says whether it worked.
//
// web/app.js is a browser IIFE and there is no DOM library in this repo, so as
// in the other web/app.js vm tests the real source text is sliced out by string
// markers and evaluated against small fake elements. The markers are the only
// coupling to the file's layout; the logic under test is the sliced code itself.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');
// web/app.js is checked in with CRLF line endings on Windows; the markers below
// contain \n, so normalise before slicing.
const SRC = fs.readFileSync(WEB_APP_JS, 'utf8').replace(/\r\n/g, '\n');

// The exact selectors the sliced code passes to closest(); the fake anchors
// answer only for these strings, so a changed selector fails the tests loudly.
const BLOCK_SEL = 'li, p, td, th, blockquote, h1, h2, h3, h4, h5, h6';
const MSG_SEL = '.msg-body, .msg-modal-body';

function slice(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  const end = SRC.indexOf(endMarker, start + 1);
  assert.ok(start >= 0 && end > start, `markers not found in web/app.js — did ${startMarker.trim().slice(0, 40)} move?`);
  return SRC.slice(start, end);
}

// Fake anchor. The sliced code only reads and writes a few properties and calls
// closest() / parentElement, so that is all this models.
class FakeAnchor {
  constructor(href, { text = '', closest = {}, parentElement = null } = {}) {
    this._attrs = { href };
    this.textContent = text;
    this._closest = closest;
    this.parentElement = parentElement;
    this.classes = [];
    this.classList = { add: (c) => this.classes.push(c), contains: (c) => this.classes.includes(c) };
    this.rel = undefined;
    this.title = '';
    this.href = href;
  }

  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; }

  setAttribute(name, value) { this._attrs[name] = value; }

  removeAttribute(name) { delete this._attrs[name]; }

  closest(selector) { return Object.prototype.hasOwnProperty.call(this._closest, selector) ? this._closest[selector] : null; }
}

function markLinksIn(anchors) {
  const code = slice('    // Every external link an agent writes', '    // "Questions for X:" blocks');
  const markLinks = vm.runInNewContext(`(function (root) {\n${code}\n})`, {});
  markLinks({ querySelectorAll: () => anchors });
  return anchors;
}

describe('web/app.js renderMarkdown — source link marking', () => {
  it('adds the src-link class to an https link', () => {
    const [a] = markLinksIn([new FakeAnchor('https://example-agency.org/guidance/')]);

    assert.equal(a.classes.includes('src-link'), true);
  });

  it('strips target from an agent link, so a plain click cannot open a new tab by itself', () => {
    const a = new FakeAnchor('https://example-agency.org/guidance/', { text: 'guidance' });
    a.setAttribute('target', '_blank');

    markLinksIn([a]);

    assert.equal(a.getAttribute('target'), null);
  });

  it('sets rel to "noopener noreferrer", overriding whatever rel the model wrote', () => {
    const a = new FakeAnchor('https://example-agency.org/guidance/');
    a.setAttribute('rel', 'nofollow');

    markLinksIn([a]);

    assert.equal(a.rel, 'noopener noreferrer');
  });

  it('gives the link the "Open this source in a preview" title', () => {
    const [a] = markLinksIn([new FakeAnchor('https://example-agency.org/guidance/')]);

    assert.equal(a.title, 'Open this source in a preview');
  });

  it('marks an upper-case HTTP:// link too, since the scheme match is case-insensitive', () => {
    const [a] = markLinksIn([new FakeAnchor('HTTP://EXAMPLE-AGENCY.ORG/guidance')]);

    assert.equal(a.classes.includes('src-link'), true);
  });

  it('leaves a mailto link alone', () => {
    const a = new FakeAnchor('mailto:regulatory@example.com');
    a.setAttribute('target', '_blank');

    markLinksIn([a]);

    assert.equal(a.classes.length, 0);
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.rel, undefined);
  });

  it('leaves a relative link alone', () => {
    const a = new FakeAnchor('#src-1');
    a.setAttribute('target', '_blank');

    markLinksIn([a]);

    assert.equal(a.classes.length, 0);
    assert.equal(a.getAttribute('target'), '_blank');
  });

  it('leaves a protocol-relative link alone, since its scheme is not http(s) in the text', () => {
    const [a] = markLinksIn([new FakeAnchor('//example-agency.org/guidance')]);

    assert.equal(a.classes.length, 0);
  });

  it('leaves a javascript: link alone, so it is never routed into the preview', () => {
    const [a] = markLinksIn([new FakeAnchor('javascript:alert(1)')]);

    assert.equal(a.classes.length, 0);
  });
});

describe('web/app.js claimAround', () => {
  const claimAround = vm.runInNewContext(
    `(function () {\n${slice('  function claimAround(a) {', '  function hostOf(url)')}\nreturn claimAround;\n})()`,
    {},
  );

  it('returns the whole block, whitespace collapsed, when the block is short', () => {
    const block = { textContent: 'Approval takes\n    120 days.' };
    const a = new FakeAnchor('https://example-agency.org/', { text: 'Approval', closest: { [BLOCK_SEL]: block } });

    assert.equal(claimAround(a), 'Approval takes 120 days.');
  });

  it('returns only the sentence the link sits in, not its neighbours, from a long paragraph', () => {
    const before = 'Fees were reviewed in 2024 by the national regulator and were found to be high across most of the board.';
    const linked = 'The agency decides within 120 days of a complete dossier, see the guidance.';
    const after = 'Reviewers in the northern provinces disagreed with this conclusion for several quite different reasons.';
    const block = { textContent: `${before} ${linked} ${after}` };
    const a = new FakeAnchor('https://example-agency.org/guidance/', { text: 'the guidance', closest: { [BLOCK_SEL]: block } });

    assert.equal(claimAround(a), linked);
  });

  it('keeps the first sentence of a long paragraph whole when the link sits in it', () => {
    const linked = 'The agency decides within 120 days of a complete dossier, see the guidance.';
    const after = 'Reviewers in the northern provinces disagreed with this conclusion for several quite different reasons.';
    const block = { textContent: `${linked} ${after} ${'Further detail follows here about fees and timing. '.repeat(3).trim()}` };
    const a = new FakeAnchor('https://example-agency.org/guidance/', { text: 'the guidance', closest: { [BLOCK_SEL]: block } });

    assert.equal(claimAround(a), linked);
  });

  it('runs to the end of the block when the linked sentence has no full stop after it', () => {
    const before = 'Fees were reviewed in 2024 by the national regulator and were found to be high across most of the board, and the review was repeated in the following year by a separate panel of advisers.';
    const linked = 'The agency decides within 120 days of a complete dossier, see the guidance';
    const block = { textContent: `${before} ${linked}` };
    const a = new FakeAnchor('https://example-agency.org/guidance/', { text: 'the guidance', closest: { [BLOCK_SEL]: block } });

    assert.equal(claimAround(a), linked);
  });

  it('caps a long block with no locatable link text at 1200 characters', () => {
    const block = { textContent: 'word '.repeat(400).trim() };
    const a = new FakeAnchor('https://example-agency.org/guidance/', { text: '', closest: { [BLOCK_SEL]: block } });

    const claim = claimAround(a);

    assert.equal(claim.length, 1200);
    assert.equal(claim, block.textContent.slice(0, 1200));
  });

  it('uses the parent element when the link is not inside a block element', () => {
    const a = new FakeAnchor('https://example-agency.org/guidance/', { text: 'guidance', parentElement: { textContent: 'Short parent text.' } });

    assert.equal(claimAround(a), 'Short parent text.');
  });
});

// The document-level click handler and the copy button, sliced out of init().
function loadClickHandler({ session = { id: 7 }, clipboard } = {}) {
  const listeners = {};
  const els = {};
  const el = (sel) => {
    if (!els[sel]) {
      els[sel] = {
        textContent: '', href: '', hidden: false, innerHTML: '',
        addEventListener(type, fn) { this[`_on_${type}`] = fn; },
      };
    }
    return els[sel];
  };
  const toasts = [];
  const modalCalls = [];
  const sandbox = {
    document: { addEventListener(type, fn) { listeners[type] = fn; } },
    navigator: { clipboard: clipboard || { writeText: async () => {} } },
    $: (sel) => el(sel),
    state: { session },
    toast: (text) => toasts.push(text),
    openSourceModal: (url, claim) => modalCalls.push({ url, claim }),
  };
  const code = slice("    document.addEventListener('click', (e) => {\n      const a = e.target.closest('a.src-link');", '    // Citation clicks open the Sources tab');
  const claimCode = slice('  function claimAround(a) {', '  function hostOf(url)');
  vm.createContext(sandbox);
  vm.runInContext(`${claimCode}\n${code}\nthis.claimAround = claimAround;`, sandbox);
  return { sandbox, listeners, el, toasts, modalCalls };
}

// A click event on a link. target.closest answers for a.src-link only, as the
// real DOM would for an anchor (or a child text node of one).
function clickOn(anchor, overrides = {}) {
  const prevented = { value: false };
  const event = {
    target: { closest: (sel) => (sel === 'a.src-link' && anchor.classes.includes('src-link') ? anchor : null) },
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    preventDefault() { prevented.value = true; },
    ...overrides,
  };
  return { event, prevented };
}

function sourceLink({ href = 'https://example-agency.org/guidance/', text = 'guidance', inMessage = true, claimBlock = null } = {}) {
  const closest = {};
  if (inMessage) closest[MSG_SEL] = { className: 'msg-body' };
  if (claimBlock) closest[BLOCK_SEL] = claimBlock;
  const a = new FakeAnchor(href, { text, closest });
  a.classes.push('src-link');
  return a;
}

describe('web/app.js document click on a source link', () => {
  it('opens the source modal with the link URL and sentence, and prevents the navigation', () => {
    const { listeners, modalCalls } = loadClickHandler();
    const block = { textContent: 'Approval takes 120 days, see the guidance.' };
    const a = sourceLink({ claimBlock: block });
    const { event, prevented } = clickOn(a);

    listeners.click(event);

    assert.equal(prevented.value, true);
    assert.deepEqual(modalCalls, [{ url: 'https://example-agency.org/guidance/', claim: 'Approval takes 120 days, see the guidance.' }]);
  });

  it('handles a source link inside the wide-view message modal the same way', () => {
    const { listeners, modalCalls } = loadClickHandler();
    const a = new FakeAnchor('https://example-agency.org/guidance/', { text: 'guidance', closest: { [MSG_SEL]: { className: 'msg-modal-body' } } });
    a.classes.push('src-link');
    const { event, prevented } = clickOn(a);

    listeners.click(event);

    assert.equal(prevented.value, true);
    assert.equal(modalCalls.length, 1);
  });

  it('ignores a source link outside a message body, so the page does its normal thing', () => {
    const { listeners, modalCalls } = loadClickHandler();
    const a = sourceLink({ inMessage: false });
    const { event, prevented } = clickOn(a);

    listeners.click(event);

    assert.equal(prevented.value, false);
    assert.equal(modalCalls.length, 0);
  });

  it('ignores an ordinary link that was not marked as a source link', () => {
    const { listeners, modalCalls } = loadClickHandler();
    const a = new FakeAnchor('https://example-agency.org/guidance/', { closest: { [MSG_SEL]: { className: 'msg-body' } } });
    const { event, prevented } = clickOn(a);

    listeners.click(event);

    assert.equal(prevented.value, false);
    assert.equal(modalCalls.length, 0);
  });

  it('lets a ctrl-click open a new tab, rather than the preview', () => {
    const { listeners, modalCalls } = loadClickHandler();
    const { event, prevented } = clickOn(sourceLink(), { ctrlKey: true });

    listeners.click(event);

    assert.equal(prevented.value, false);
    assert.equal(modalCalls.length, 0);
  });

  it('lets a cmd-click (meta) open a new tab, rather than the preview', () => {
    const { listeners, modalCalls } = loadClickHandler();
    const { event, prevented } = clickOn(sourceLink(), { metaKey: true });

    listeners.click(event);

    assert.equal(prevented.value, false);
    assert.equal(modalCalls.length, 0);
  });

  it('lets a shift-click open a new window, rather than the preview', () => {
    const { listeners, modalCalls } = loadClickHandler();
    const { event, prevented } = clickOn(sourceLink(), { shiftKey: true });

    listeners.click(event);

    assert.equal(prevented.value, false);
    assert.equal(modalCalls.length, 0);
  });

  it('lets an alt-click through, rather than the preview', () => {
    const { listeners, modalCalls } = loadClickHandler();
    const { event, prevented } = clickOn(sourceLink(), { altKey: true });

    listeners.click(event);

    assert.equal(prevented.value, false);
    assert.equal(modalCalls.length, 0);
  });

  it('lets a middle-button click through, rather than the preview', () => {
    const { listeners, modalCalls } = loadClickHandler();
    const { event, prevented } = clickOn(sourceLink(), { button: 1 });

    listeners.click(event);

    assert.equal(prevented.value, false);
    assert.equal(modalCalls.length, 0);
  });

  it('does not open the modal when no session is loaded', () => {
    const { listeners, modalCalls } = loadClickHandler({ session: null });
    const { event } = clickOn(sourceLink());

    listeners.click(event);

    assert.equal(modalCalls.length, 0);
  });
});

describe('web/app.js copy link button in the source modal', () => {
  it('copies the modal URL to the clipboard and confirms with "Link copied."', async () => {
    const copied = [];
    const { el, toasts, sandbox } = loadClickHandler({
      clipboard: { writeText: async (t) => { copied.push(t); } },
    });
    el('#source-modal-url').textContent = 'https://example-agency.org/guidance/';
    sandbox.$('#btn-source-copy')._on_click();
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(copied, ['https://example-agency.org/guidance/']);
    assert.deepEqual(toasts, ['Link copied.']);
  });

  it('says "Could not copy the link." when the clipboard refuses', async () => {
    const { el, toasts, sandbox } = loadClickHandler({
      clipboard: { writeText: async () => { throw new Error('denied'); } },
    });
    el('#source-modal-url').textContent = 'https://example-agency.org/guidance/';
    sandbox.$('#btn-source-copy')._on_click();
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(toasts, ['Could not copy the link.']);
  });
});
