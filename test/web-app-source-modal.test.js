'use strict';
// web/app.js: the source preview modal. openSourceModal opens #dlg-source for a
// link and asks the server for its preview; renderSourcePreview fills the modal
// from the answer. Two things matter most: what the reader sees (what the agent
// said, the page's passage marked as a quote or as a closest match, and any
// note explaining why there is no passage), and the stale-response guard, so a
// slow answer for an earlier link cannot paint over the link the reader is on.
//
// web/app.js is a browser IIFE and the repo has no DOM library, so as in the
// other web/app.js vm tests the real source is sliced out by markers and run
// against small fake elements. The API is a stub whose answers each test
// controls, so no request is made.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');
// web/app.js is checked in with CRLF line endings on Windows; the markers below
// contain \n, so normalise before slicing.
const SRC = fs.readFileSync(WEB_APP_JS, 'utf8').replace(/\r\n/g, '\n');

function slice(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  const end = SRC.indexOf(endMarker, start + 1);
  assert.ok(start >= 0 && end > start, `markers not found in web/app.js — did ${startMarker.trim().slice(0, 40)} move?`);
  return SRC.slice(start, end);
}

function sliceLine(startMarker) {
  const start = SRC.indexOf(startMarker);
  assert.ok(start >= 0, `marker not found in web/app.js — did ${startMarker.trim().slice(0, 40)} move?`);
  return SRC.slice(start, SRC.indexOf('\n', start));
}

class FakeElement {
  constructor() { this.textContent = ''; this.innerHTML = ''; this.href = ''; this.hidden = false; this.opened = 0; }

  showModal() { this.opened += 1; }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function loadSourceModal() {
  const elements = {};
  const el = (sel) => { if (!elements[sel]) elements[sel] = new FakeElement(); return elements[sel]; };
  const apiCalls = [];
  const sandbox = {
    // A vm context has no Node globals; the browser's URL parser is what hostOf uses.
    URL,
    $: (sel) => el(sel),
    state: { session: { id: 7 } },
    api: {
      get: (url) => {
        const d = deferred();
        apiCalls.push({ url, d });
        return d.promise;
      },
    },
  };
  const code = `(function () {
${sliceLine('  function escapeHtml(s) {')}
${sliceLine('  const AGENT_LABEL = ')}
${slice('  // ---------------- source preview modal', '  function applyFilter() {')}
return { openSourceModal, renderSourcePreview };
})()`;
  const api = vm.runInNewContext(code, sandbox);
  return { ...api, el, apiCalls };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('web/app.js openSourceModal', () => {
  it('shows the link host as the title, without a www prefix', () => {
    const { openSourceModal, el } = loadSourceModal();

    openSourceModal('https://www.example-agency.org/guidance/', '');

    assert.equal(el('#source-modal-title').textContent, 'example-agency.org');
  });

  it('shows the full URL, and points "Open in new tab" at it', () => {
    const { openSourceModal, el } = loadSourceModal();

    openSourceModal('https://example-agency.org/guidance/', '');

    assert.equal(el('#source-modal-url').textContent, 'https://example-agency.org/guidance/');
    assert.equal(el('#source-modal-url').href, 'https://example-agency.org/guidance/');
    assert.equal(el('#btn-source-open').href, 'https://example-agency.org/guidance/');
  });

  it('opens the dialog and shows the reading placeholder until the server answers', () => {
    const { openSourceModal, el } = loadSourceModal();

    openSourceModal('https://example-agency.org/guidance/', '');

    assert.equal(el('#dlg-source').opened, 1);
    assert.match(el('#source-modal-body').innerHTML, /Reading the page…/);
  });

  it('asks the server for this session\'s preview with the URL and claim, both URL-encoded', () => {
    const { openSourceModal, apiCalls } = loadSourceModal();

    openSourceModal('https://example-agency.org/a?b=1', 'Fees & timing');

    assert.equal(apiCalls.length, 1);
    assert.equal(apiCalls[0].url, '/api/sessions/7/source-preview?url=https%3A%2F%2Fexample-agency.org%2Fa%3Fb%3D1&claim=Fees%20%26%20timing');
  });

  it('shows the agent\'s claim, escaped, in the claim panel', () => {
    const { openSourceModal, el } = loadSourceModal();

    openSourceModal('https://example-agency.org/guidance/', '<img src=x onerror=alert(1)> 120 days');

    assert.equal(el('#source-modal-claim').hidden, false);
    assert.match(el('#source-modal-claim').innerHTML, /&lt;img src=x onerror=alert\(1\)&gt; 120 days/);
    assert.doesNotMatch(el('#source-modal-claim').innerHTML, /<img/);
  });

  it('hides the claim panel when no sentence was sent with the link', () => {
    const { openSourceModal, el } = loadSourceModal();

    openSourceModal('https://example-agency.org/guidance/', '');

    assert.equal(el('#source-modal-claim').hidden, true);
    assert.equal(el('#source-modal-claim').innerHTML, '');
  });

  it('uses the raw string as the title when the link cannot be parsed as a URL', () => {
    const { openSourceModal, el } = loadSourceModal();

    openSourceModal('not a url', '');

    assert.equal(el('#source-modal-title').textContent, 'not a url');
  });
});

describe('web/app.js renderSourcePreview', () => {
  it('shows the source number, the kind, and who cited it, de-duplicated and labelled', () => {
    const { renderSourcePreview, el } = loadSourceModal();

    renderSourcePreview({
      source: { n: 2, kind: 'cited', cited_by: [{ speaker: 'moderator' }, { speaker: 'moderator' }, { speaker: 'autopilot' }] },
    });

    assert.match(el('#source-modal-meta').innerHTML, /<span class="n">\[2\]<\/span>/);
    assert.match(el('#source-modal-meta').innerHTML, /<span class="kind cited">cited<\/span>/);
    assert.match(el('#source-modal-meta').innerHTML, /Cited by Moderator Assistant, Autopilot</);
  });

  it('labels a page the agent only found by search as "search result", not "cited"', () => {
    const { renderSourcePreview, el } = loadSourceModal();

    renderSourcePreview({ source: { n: 3, kind: 'searched', cited_by: [] } });

    assert.match(el('#source-modal-meta').innerHTML, /<span class="kind searched">search result<\/span>/);
    assert.doesNotMatch(el('#source-modal-meta').innerHTML, /Cited by/);
  });

  it('labels an unverified link as unverified, never as searched', () => {
    const { renderSourcePreview, el } = loadSourceModal();

    renderSourcePreview({ source: { n: 4, kind: 'unverified', cited_by: [] } });

    assert.match(el('#source-modal-meta').innerHTML, /<span class="kind unverified">unverified link<\/span>/);
  });

  it('shows the published date when the page has one', () => {
    const { renderSourcePreview, el } = loadSourceModal();

    renderSourcePreview({ published: '2026-03-01' });

    assert.match(el('#source-modal-meta').innerHTML, /<span class="muted">Published 2026-03-01<\/span>/);
  });

  it('replaces the host title with the page title when the server sends one', () => {
    const { openSourceModal, renderSourcePreview, el } = loadSourceModal();
    openSourceModal('https://example-agency.org/guidance/', '');

    renderSourcePreview({ title: 'Agency guidance page' });

    assert.equal(el('#source-modal-title').textContent, 'Agency guidance page');
  });

  it('keeps the host title when the server sends no page title', () => {
    const { openSourceModal, renderSourcePreview, el } = loadSourceModal();
    openSourceModal('https://example-agency.org/guidance/', '');

    renderSourcePreview({ title: '' });

    assert.equal(el('#source-modal-title').textContent, 'example-agency.org');
  });

  it('marks a verbatim quotation as "Quoted on this page", with no wording caveat', () => {
    const { renderSourcePreview, el } = loadSourceModal();

    renderSourcePreview({ excerpt: { quoted: true, before: 'Before.', match: 'Quoted words', after: 'After.' } });

    const body = el('#source-modal-body').innerHTML;
    assert.match(body, /<span class="source-label">Quoted on this page<\/span>/);
    assert.match(body, /<mark>Quoted words<\/mark>/);
    assert.doesNotMatch(body, /Matched on wording/);
  });

  it('marks a best-match passage as "Closest passage on this page", with the wording caveat', () => {
    const { renderSourcePreview, el } = loadSourceModal();

    renderSourcePreview({ excerpt: { quoted: false, before: '', match: 'Closest words', after: '' } });

    const body = el('#source-modal-body').innerHTML;
    assert.match(body, /<span class="source-label">Closest passage on this page<\/span>/);
    assert.match(body, /Matched on wording, not a quotation/);
  });

  it('escapes the page text it puts into the excerpt, so page markup cannot run', () => {
    const { renderSourcePreview, el } = loadSourceModal();

    renderSourcePreview({ excerpt: { quoted: true, before: '<script>steal()</script>', match: 'm', after: '' } });

    const body = el('#source-modal-body').innerHTML;
    assert.match(body, /&lt;script&gt;steal\(\)&lt;\/script&gt;/);
    assert.doesNotMatch(body, /<script>/);
  });

  it('shows the server note in place of an excerpt when there is no passage', () => {
    const { renderSourcePreview, el } = loadSourceModal();

    renderSourcePreview({ excerpt: null, note: 'No passage on this page matches what the agent said closely enough to highlight.' });

    assert.equal(el('#source-modal-body').innerHTML, '<div class="source-note">No passage on this page matches what the agent said closely enough to highlight.</div>');
  });

  it('shows a generic message when there is neither an excerpt nor a note', () => {
    const { renderSourcePreview, el } = loadSourceModal();

    renderSourcePreview({ excerpt: null });

    assert.equal(el('#source-modal-body').innerHTML, '<div class="source-note">Nothing on this page could be matched to what the agent said.</div>');
  });
});

describe('web/app.js source preview requests that finish out of order', () => {
  it('a slow answer for an earlier link cannot overwrite the modal once a newer link has been opened', async () => {
    const { openSourceModal, apiCalls, el } = loadSourceModal();
    openSourceModal('https://first.example.org/a', '');
    openSourceModal('https://second.example.org/b', '');

    apiCalls[1].d.resolve({ title: 'Second page', excerpt: { quoted: true, before: '', match: 'second passage', after: '' } });
    await flush();
    apiCalls[0].d.resolve({ title: 'First page', excerpt: { quoted: true, before: '', match: 'first passage', after: '' } });
    await flush();

    assert.equal(el('#source-modal-title').textContent, 'Second page');
    assert.match(el('#source-modal-body').innerHTML, /second passage/);
    assert.doesNotMatch(el('#source-modal-body').innerHTML, /first passage/);
  });

  it('an error for an earlier link does not replace the newer link\'s preview', async () => {
    const { openSourceModal, apiCalls, el } = loadSourceModal();
    openSourceModal('https://first.example.org/a', '');
    openSourceModal('https://second.example.org/b', '');

    apiCalls[1].d.resolve({ title: 'Second page', excerpt: { quoted: true, before: '', match: 'second passage', after: '' } });
    await flush();
    apiCalls[0].d.reject(new Error('Server says no'));
    await flush();

    assert.match(el('#source-modal-body').innerHTML, /second passage/);
    assert.doesNotMatch(el('#source-modal-body').innerHTML, /Server says no/);
  });

  it('shows the error message in the body when the preview request for the current link fails', async () => {
    const { openSourceModal, apiCalls, el } = loadSourceModal();
    openSourceModal('https://only.example.org/a', '');

    apiCalls[0].d.reject(new Error('Server says no'));
    await flush();

    assert.equal(el('#source-modal-body').innerHTML, '<div class="source-note">Server says no</div>');
  });
});
