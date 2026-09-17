'use strict';
// renderPowerNav() fills every view's .power-nav with the shared power
// buttons (User Guide / Agents / Admin), syncPowerNav() mirrors
// state.navPanel onto their aria-pressed attributes, and showSessionPane()
// swaps the transcript for an Intelligence tab. As in the other web/app.js vm
// tests, the function range is sliced out of web/app.js by string markers and
// run in a vm context against fake $/$$/state — real DOM query selectors and
// classList aren't available in a vm sandbox, so this stubs just enough of
// $ / $$ to reach those three functions.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const INDEX_HTML = path.join(__dirname, '..', 'web', 'index.html');

// Turns the innerHTML string renderPowerNav() assigns into a list of fake
// button nodes with a mutable dataset/attrs, mirroring how the browser
// parses markup into queryable elements.
function parseButtons(html) {
  const out = [];
  const re = /<button\b[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const idM = tag.match(/\bid="([^"]+)"/);
    const navM = tag.match(/data-nav="([^"]+)"/);
    const ariaM = tag.match(/aria-pressed="([^"]+)"/);
    const attrs = { 'aria-pressed': ariaM ? ariaM[1] : 'false' };
    const btn = {
      id: idM ? idM[1] : undefined,
      dataset: navM ? { nav: navM[1] } : {},
      setAttribute(name, val) { attrs[name] = String(val); },
      getAttribute(name) { return attrs[name]; },
    };
    out.push(btn);
  }
  return out;
}

class FakeNav {
  constructor() {
    this.buttons = [];
    this._html = '';
  }

  set innerHTML(html) { this._html = html; this.buttons = parseButtons(html); }

  get innerHTML() { return this._html; }
}

// The Intelligence tab keys, read from index.html's tab bodies so the fake page
// cannot drift from the real one.
const TABS = [...fs.readFileSync(INDEX_HTML, 'utf8').matchAll(/class="tab-body" id="tab-([a-z]+)"/g)].map((m) => m[1]);

// The session view's two panes and the Intelligence page's parts, as far as
// showSessionPane touches them.
function fakePage() {
  const el = () => ({ hidden: false, textContent: '', scrollTop: 0, scrollHeight: 0 });
  const page = { '#transcript': el(), '.transcript-col': el(), '#intel-page': el(), '#intel-page-title': el(), '#intel-page-select': { value: '' } };
  for (const t of TABS) page[`#tab-${t}`] = el();
  page['#intel-page'].hidden = true;
  const navItems = ['transcript', ...TABS].map((pane) => {
    const attrs = {};
    return {
      dataset: { pane },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      removeAttribute: (k) => { delete attrs[k]; },
      getAttribute: (k) => attrs[k],
    };
  });
  return { page, navItems };
}

function loadPowerNav({ navCount = 1, isAdmin = false, navPanel = null, warRoomOpen = false } = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf("  // Header power buttons, filled into every view's .power-nav.");
  const end = src.indexOf('  // ---------------- session view ----------------');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did renderPowerNav/syncPowerNav/showSessionPane move?');

  const navs = Array.from({ length: navCount }, () => new FakeNav());
  const { page, navItems } = fakePage();
  const ctx = {
    state: { me: { is_admin: isAdmin }, navPanel, warRoomOpen, activeTab: 'sources' },
    escapeHtml: (s) => String(s),
    icon: (name) => `<icon:${name}>`,
    $: (sel) => {
      if (sel in page) return page[sel];
      throw new Error(`unexpected $ selector: ${sel}`);
    },
    $$: (sel) => {
      if (sel === '.power-nav') return navs;
      if (sel === '#intel-nav [data-pane]') return navItems;
      if (sel === '.power-btn[data-nav]') return navs.flatMap((n) => n.buttons.filter((b) => b.dataset.nav));
      throw new Error(`unexpected $$ selector: ${sel}`);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${src.slice(start, end)}\nthis.renderPowerNav = renderPowerNav;\nthis.syncPowerNav = syncPowerNav;\nthis.showSessionPane = showSessionPane;\nthis.INTEL_TABS = INTEL_TABS;`,
    ctx,
  );
  ctx.renderPowerNav();
  return { ctx, navs, page, navItems };
}

function ctxAssertNavKeys(nav, expected) {
  const keys = nav.buttons.filter((b) => b.dataset.nav).map((b) => b.dataset.nav);
  assert.deepEqual(keys, expected);
}

describe('web/app.js renderPowerNav — button set', () => {
  it('renders User Guide and Agents but no Admin for a non-admin user', () => {
    const { navs } = loadPowerNav({ isAdmin: false });

    ctxAssertNavKeys(navs[0], ['guide', 'agents']);
  });

  it('renders User Guide, Agents and Admin for an admin user', () => {
    const { navs } = loadPowerNav({ isAdmin: true });

    ctxAssertNavKeys(navs[0], ['guide', 'agents', 'admin']);
  });

  it('renders no Intelligence button in any header: Intelligence is reached from the sidebar', () => {
    const { navs } = loadPowerNav({ navCount: 3, isAdmin: true });

    for (const nav of navs) {
      assert.equal(nav.buttons.length, 3);
      assert.equal(nav.buttons.every((b) => b.dataset.nav), true, 'every header button opens a drawer');
    }
  });
});

describe('web/app.js syncPowerNav — aria-pressed', () => {
  it('marks the button matching state.navPanel as pressed and the rest as not', () => {
    const { ctx, navs } = loadPowerNav({ isAdmin: true, navPanel: 'agents' });

    ctx.syncPowerNav();

    const pressed = navs[0].buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.nav);
    assert.deepEqual(pressed, ['agents']);
    assert.equal(navs[0].buttons.find((b) => b.dataset.nav === 'guide').getAttribute('aria-pressed'), 'false');
    assert.equal(navs[0].buttons.find((b) => b.dataset.nav === 'admin').getAttribute('aria-pressed'), 'false');
  });

  it('clears aria-pressed on every [data-nav] button when state.navPanel is null', () => {
    const { ctx, navs } = loadPowerNav({ isAdmin: true, navPanel: null });

    ctx.syncPowerNav();

    assert.equal(navs[0].buttons.every((b) => b.getAttribute('aria-pressed') === 'false'), true);
  });
});

describe('web/app.js INTEL_TABS — matches the page', () => {
  it('lists exactly the tab bodies in index.html, with Reports folded into Decision', () => {
    const { ctx } = loadPowerNav();

    assert.deepEqual([...ctx.INTEL_TABS].sort(), [...TABS].sort());
    assert.equal(TABS.includes('reports'), false);
  });

  it('puts Agent notes above Agent Questions in the sidebar and the narrow-screen picker', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const order = (re) => [...html.matchAll(re)].map((m) => m[1]);
    const nav = order(/data-pane="([a-z]+)"/g);
    const picker = order(/<option value="(transcript|sources|disagreements|intelligence|questions|escalations|decision|minutes|favourites|inputs)"/g);

    for (const list of [nav, picker]) {
      assert.ok(list.indexOf('intelligence') >= 0 && list.indexOf('intelligence') < list.indexOf('questions'), `order was ${list.join(', ')}`);
    }
  });
});

describe('web/app.js showSessionPane — the Intelligence page', () => {
  const current = (navItems) => navItems.filter((b) => b.getAttribute('aria-current') === 'page').map((b) => b.dataset.pane);

  it('shows a tab in place of the transcript and marks it current', () => {
    const { ctx, page, navItems } = loadPowerNav();

    ctx.showSessionPane('escalations');

    assert.equal(ctx.state.warRoomOpen, true);
    assert.equal(page['#intel-page'].hidden, false);
    assert.equal(page['.transcript-col'].hidden, true);
    assert.equal(page['#tab-escalations'].hidden, false);
    assert.equal(page['#tab-sources'].hidden, true);
    assert.equal(page['#intel-page-title'].textContent, 'Escalations');
    assert.deepEqual(current(navItems), ['escalations']);
    assert.equal(page['#intel-page-select'].value, 'escalations', 'the narrow-screen picker follows the page');
  });

  it('titles the Decision tab as holding the reports too', () => {
    const { ctx, page } = loadPowerNav();

    ctx.showSessionPane('decision');

    assert.equal(page['#intel-page-title'].textContent, 'Decision & reports');
  });

  it('goes back to the transcript and keeps the tab for next time', () => {
    const { ctx, page, navItems } = loadPowerNav();
    ctx.showSessionPane('minutes');

    ctx.showSessionPane('transcript');

    assert.equal(ctx.state.warRoomOpen, false);
    assert.equal(ctx.state.activeTab, 'minutes');
    assert.equal(page['#intel-page'].hidden, true);
    assert.equal(page['.transcript-col'].hidden, false);
    assert.deepEqual(current(navItems), ['transcript']);
    assert.equal(page['#intel-page-select'].value, 'transcript');
  });

  it('puts the transcript back at the scroll position it had before the page opened', () => {
    const { ctx, page } = loadPowerNav();
    page['#transcript'].scrollTop = 480;

    ctx.showSessionPane('sources');
    page['#transcript'].scrollTop = 0; // hidden: the browser may drop it
    ctx.showSessionPane('transcript');

    assert.equal(page['#transcript'].scrollTop, 480);
  });
});
