'use strict';
// init() builds #sidebar-foot from footLines. The "Default model" line was
// removed from the sidebar (the New Evaluation form's picker shows it), so the
// only line left is the "No API key" warning, suppressed when
// state.config.has_api_key is true, for admins and non-admins alike. The foot
// must never carry the old Agents/Admin .navlink markup either. As in the
// other web/app.js vm tests, the block is sliced out of init() by string
// markers and run in a vm context against a fake $/document.body.classList/state.config.
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
  const start = src.indexOf('    const footLines = [');
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
  for (const nonAdmin of [false, true]) {
    const who = nonAdmin ? 'a non-admin' : 'an admin';

    it(`is empty and hidden for ${who} user with an API key: no default-model line`, () => {
      const foot = runFootLines({ nonAdmin, hasApiKey: true, model: 'gpt-5' });

      assert.equal(foot.innerHTML, '');
      assert.equal(foot.hidden, true);
    });

    it(`shows only the no-API-key warning for ${who} user with no API key`, () => {
      const foot = runFootLines({ nonAdmin, hasApiKey: false, model: 'gpt-5' });

      assert.equal(foot.innerHTML, '<strong style="color:#B91C1C">No API key: add it to .env and restart</strong>');
      assert.equal(foot.innerHTML.includes('Default model'), false);
      assert.equal(foot.innerHTML.includes('gpt-5'), false);
      assert.equal(foot.innerHTML.includes('navlink'), false);
      assert.equal(foot.hidden, false);
    });
  }
});
