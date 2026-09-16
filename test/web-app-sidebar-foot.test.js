'use strict';
// init() builds #sidebar-foot from footLines: a "Default model <code>...</code>"
// line (suppressed for a non-admin user, via document.body.classList
// contains('non-admin')) and a "No API key" warning (suppressed when
// state.config.has_api_key is true). Agents/Admin links used to live in this
// foot as .navlink buttons; they moved to the header power buttons, so the
// foot should never contain that markup any more. As in the other web/app.js
// vm tests, the block is sliced out of init() by string markers and run in a
// vm context against a fake $/document.body.classList/state.config.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');

class FakeFoot {
  constructor() { this._html = ''; this.hidden = false; }

  set innerHTML(v) { this._html = v; }

  get innerHTML() { return this._html; }
}

function runFootLines({ nonAdmin = false, hasApiKey = true, model = 'gpt-5' } = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf('    // "Default" since the New Evaluation form can start a session on any of the');
  const end = src.indexOf('    await loadSessions();', start);
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did the sidebar-foot block move?');

  const foot = new FakeFoot();
  const ctx = {
    document: { body: { classList: { contains: (cls) => cls === 'non-admin' && nonAdmin } } },
    state: { config: { model, has_api_key: hasApiKey } },
    escapeHtml: (s) => String(s),
    $: (sel) => {
      if (sel === '#sidebar-foot') return foot;
      throw new Error(`unexpected $ selector: ${sel}`);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end), ctx);
  return foot;
}

describe('web/app.js init — #sidebar-foot', () => {
  it('shows only the default-model line for an admin user with an API key', () => {
    const foot = runFootLines({ nonAdmin: false, hasApiKey: true, model: 'gpt-5' });

    assert.equal(foot.innerHTML, 'Default model <code>gpt-5</code>');
    assert.equal(foot.hidden, false);
    assert.equal(foot.innerHTML.includes('data-nav'), false);
    assert.equal(foot.innerHTML.includes('navlink'), false);
  });

  it('is empty and hidden for a non-admin user with an API key', () => {
    const foot = runFootLines({ nonAdmin: true, hasApiKey: true });

    assert.equal(foot.innerHTML, '');
    assert.equal(foot.hidden, true);
  });

  it('shows only the no-API-key warning for a non-admin user with no API key', () => {
    const foot = runFootLines({ nonAdmin: true, hasApiKey: false });

    assert.equal(foot.innerHTML, '<strong style="color:#B91C1C">No API key: add it to .env and restart</strong>');
    assert.equal(foot.innerHTML.startsWith('<br>'), false);
    assert.equal(foot.hidden, false);
  });

  it('joins the model line and the warning with a single <br> for an admin user with no API key', () => {
    const foot = runFootLines({ nonAdmin: false, hasApiKey: false, model: 'gpt-5' });

    assert.equal(
      foot.innerHTML,
      'Default model <code>gpt-5</code><br><strong style="color:#B91C1C">No API key: add it to .env and restart</strong>',
    );
    assert.equal(foot.hidden, false);
  });
});
