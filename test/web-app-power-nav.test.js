'use strict';
// renderPowerNav() fills every view's .power-nav with the shared power
// buttons (User Guide / Agents / Admin, plus Intelligence in the session
// view only), and syncPowerNav() mirrors state.navPanel / state.warRoomOpen
// onto their aria-pressed attributes. As in the other web/app.js vm tests,
// the function range is sliced out of web/app.js by string markers and run
// in a vm context against fake $/$$/state — real DOM query selectors and
// classList aren't available in a vm sandbox, so this stubs just enough of
// $ / $$ to reach renderPowerNav/syncPowerNav/setWarRoom.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');

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
  constructor(hasIntelligence) {
    this._hasIntelligence = hasIntelligence;
    this.buttons = [];
    this._html = '';
  }

  hasAttribute(name) { return name === 'data-intelligence' && this._hasIntelligence; }

  set innerHTML(html) { this._html = html; this.buttons = parseButtons(html); }

  get innerHTML() { return this._html; }
}

// The session view's two panes and the Intelligence page's parts, as far as
// showSessionPane touches them.
function fakePage() {
  const el = () => ({ hidden: false, textContent: '', scrollTop: 0, scrollHeight: 0 });
  const tabs = ['sources', 'disagreements', 'questions', 'escalations', 'decision', 'favourites', 'reports', 'minutes', 'intelligence', 'inputs'];
  const page = { '#transcript': el(), '.transcript-col': el(), '#intel-page': el(), '#intel-page-title': el(), '#intel-page-select': { value: '' } };
  for (const t of tabs) page[`#tab-${t}`] = el();
  page['#intel-page'].hidden = true;
  const navItems = ['transcript', ...tabs].map((pane) => {
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

// navShape: array of booleans, one per .power-nav in the view, true where
// that nav carries data-intelligence (only the session view's does).
function loadPowerNav({ navShape = [false], isAdmin = false, navPanel = null, warRoomOpen = false } = {}) {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const start = src.indexOf("  // Header power buttons, filled into every view's .power-nav.");
  const end = src.indexOf('  // ---------------- session view ----------------');
  assert.ok(start >= 0 && end > start, 'markers not found in web/app.js — did renderPowerNav/syncPowerNav/setWarRoom move?');

  const navs = navShape.map((hasIntelligence) => new FakeNav(hasIntelligence));
  const { page, navItems } = fakePage();
  const ctx = {
    state: { me: { is_admin: isAdmin }, navPanel, warRoomOpen, activeTab: 'sources' },
    escapeHtml: (s) => String(s),
    icon: (name) => `<icon:${name}>`,
    $: (sel) => {
      if (sel === '#btn-warroom') {
        for (const nav of navs) {
          const b = nav.buttons.find((btn) => btn.id === 'btn-warroom');
          if (b) return b;
        }
        return null;
      }
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
    `${src.slice(start, end)}\nthis.renderPowerNav = renderPowerNav;\nthis.syncPowerNav = syncPowerNav;\nthis.setWarRoom = setWarRoom;\nthis.showSessionPane = showSessionPane;`,
    ctx,
  );
  ctx.renderPowerNav();
  return { ctx, navs, page, navItems };
}

describe('web/app.js renderPowerNav — button set', () => {
  it('renders User Guide and Agents but no Admin for a non-admin user', () => {
    const { navs } = loadPowerNav({ navShape: [false], isAdmin: false });

    ctxAssertNavKeys(navs[0], ['guide', 'agents']);
  });

  it('renders User Guide, Agents and Admin for an admin user', () => {
    const { navs } = loadPowerNav({ navShape: [false], isAdmin: true });

    ctxAssertNavKeys(navs[0], ['guide', 'agents', 'admin']);
  });
});

function ctxAssertNavKeys(nav, expected) {
  const keys = nav.buttons.filter((b) => b.dataset.nav).map((b) => b.dataset.nav);
  assert.deepEqual(keys, expected);
}

describe('web/app.js renderPowerNav — Intelligence placement', () => {
  it('puts an Intelligence button first, only in the data-intelligence nav', () => {
    const { navs } = loadPowerNav({ navShape: [false, true], isAdmin: false });

    const plainNav = navs[0];
    const intelNav = navs[1];

    assert.equal(plainNav.buttons.some((b) => b.id === 'btn-warroom'), false);
    assert.equal(intelNav.buttons[0].id, 'btn-warroom');
    assert.deepEqual(intelNav.buttons.slice(1).map((b) => b.dataset.nav), ['guide', 'agents']);
  });

  it('omits the Intelligence button from every nav when none carries data-intelligence', () => {
    const { navs } = loadPowerNav({ navShape: [false, false], isAdmin: false });

    assert.equal(navs.every((n) => !n.buttons.some((b) => b.id === 'btn-warroom')), true);
  });
});

describe('web/app.js syncPowerNav — aria-pressed', () => {
  it('marks the button matching state.navPanel as pressed and the rest as not', () => {
    const { ctx, navs } = loadPowerNav({ navShape: [false], isAdmin: true, navPanel: 'agents' });

    ctx.syncPowerNav();

    const pressed = navs[0].buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.nav);
    assert.deepEqual(pressed, ['agents']);
    assert.equal(navs[0].buttons.find((b) => b.dataset.nav === 'guide').getAttribute('aria-pressed'), 'false');
    assert.equal(navs[0].buttons.find((b) => b.dataset.nav === 'admin').getAttribute('aria-pressed'), 'false');
  });

  it('clears aria-pressed on every [data-nav] button when state.navPanel is null', () => {
    const { ctx, navs } = loadPowerNav({ navShape: [false], isAdmin: true, navPanel: null });

    ctx.syncPowerNav();

    assert.equal(navs[0].buttons.every((b) => b.getAttribute('aria-pressed') === 'false'), true);
  });

  it('sets #btn-warroom aria-pressed from state.warRoomOpen when it is present', () => {
    const { ctx, navs } = loadPowerNav({ navShape: [true], isAdmin: false, warRoomOpen: true });

    ctx.syncPowerNav();

    assert.equal(navs[0].buttons.find((b) => b.id === 'btn-warroom').getAttribute('aria-pressed'), 'true');
  });

  it('does not throw when no #btn-warroom exists, even with state.warRoomOpen true', () => {
    const { ctx } = loadPowerNav({ navShape: [false], isAdmin: false, warRoomOpen: true });

    assert.doesNotThrow(() => ctx.syncPowerNav());
  });
});

describe('web/app.js setWarRoom — the Intelligence page', () => {
  const current = (navItems) => navItems.filter((b) => b.getAttribute('aria-current') === 'page').map((b) => b.dataset.pane);

  it('shows the page on its last tab in place of the transcript, and marks #btn-warroom pressed', () => {
    const { ctx, navs, page, navItems } = loadPowerNav({ navShape: [true], isAdmin: false, warRoomOpen: false });
    ctx.state.activeTab = 'escalations';

    ctx.setWarRoom(true);

    assert.equal(ctx.state.warRoomOpen, true);
    assert.equal(page['#intel-page'].hidden, false);
    assert.equal(page['.transcript-col'].hidden, true);
    assert.equal(page['#tab-escalations'].hidden, false);
    assert.equal(page['#tab-sources'].hidden, true);
    assert.equal(page['#intel-page-title'].textContent, 'Escalations');
    assert.deepEqual(current(navItems), ['escalations']);
    assert.equal(page['#intel-page-select'].value, 'escalations', 'the narrow-screen picker follows the page');
    assert.equal(navs[0].buttons.find((b) => b.id === 'btn-warroom').getAttribute('aria-pressed'), 'true');
  });

  it('goes back to the transcript, keeps the tab for next time, and clears #btn-warroom pressed', () => {
    const { ctx, navs, page, navItems } = loadPowerNav({ navShape: [true], isAdmin: false, warRoomOpen: false });
    ctx.showSessionPane('minutes');

    ctx.setWarRoom(false);

    assert.equal(ctx.state.warRoomOpen, false);
    assert.equal(ctx.state.activeTab, 'minutes');
    assert.equal(page['#intel-page'].hidden, true);
    assert.equal(page['.transcript-col'].hidden, false);
    assert.deepEqual(current(navItems), ['transcript']);
    assert.equal(navs[0].buttons.find((b) => b.id === 'btn-warroom').getAttribute('aria-pressed'), 'false');
  });

  it('puts the transcript back at the scroll position it had before the page opened', () => {
    const { ctx, page } = loadPowerNav({ navShape: [true], isAdmin: false, warRoomOpen: false });
    page['#transcript'].scrollTop = 480;

    ctx.showSessionPane('sources');
    page['#transcript'].scrollTop = 0; // hidden: the browser may drop it
    ctx.showSessionPane('transcript');

    assert.equal(page['#transcript'].scrollTop, 480);
  });
});
