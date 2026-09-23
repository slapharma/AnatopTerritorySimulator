'use strict';
// Collapsing the sidebar used to crush the whole page into the left edge.
// .app.sidebar-collapsed kept a two-track grid ("0 1fr") while hiding the
// sidebar with display:none. A display:none element is not a grid item, and
// #btn-sidebar-expand is position:fixed so it is not one either, which left
// .main as the only item: auto-placement puts it in the FIRST track, the 0px
// one. The topbar title wrapped one word per line, the header buttons sat
// beside it, and the view body had no width at all. This reads the stylesheet
// and the markup and checks the collapsed grid has a track for .main to land
// in at full width.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const css = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

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

describe('collapsed sidebar layout', () => {
  it('the sidebar is display:none when collapsed, so it leaves the grid', () => {
    assert.equal(decl('.app.sidebar-collapsed .sidebar', 'display'), 'none');
  });

  it('the expand button is position:fixed, so it is not a grid item either', () => {
    assert.match(html, /<div class="app">\s*<button[^>]*id="btn-sidebar-expand"/);
    assert.equal(decl('.sidebar-expand-btn', 'position'), 'fixed');
  });

  it('.main, the only grid item left, gets a full-width track', () => {
    const tracks = decl('.app.sidebar-collapsed', 'grid-template-columns');
    assert.ok(tracks, '.app.sidebar-collapsed must set grid-template-columns');
    const mainColumn = decl('.main', 'grid-column');
    // With no explicit placement .main auto-places into track 1, so the
    // collapsed grid must be that one flexible track.
    if (!mainColumn) assert.equal(tracks.split(/\s+/).length, 1, `collapsed grid is "${tracks}": .main lands in its first track`);
  });

  it('the topbar clears the fixed expand button (left 12px + 28px wide)', () => {
    const btnRight = parseInt(decl('.sidebar-expand-btn', 'left'), 10) + parseInt(decl('.sidebar-expand-btn', 'width'), 10);
    const pad = parseInt(decl('.app.sidebar-collapsed .topbar', 'padding-left'), 10);
    assert.ok(pad > btnRight, `topbar padding-left ${pad}px must clear the button's right edge at ${btnRight}px`);
  });

  it('on narrow screens, where the sidebar is always hidden, the expand button is hidden too', () => {
    const narrow = '@media (max-width: 900px)';
    assert.equal(decl('.sidebar', 'display', narrow), 'none');
    assert.equal(decl('.sidebar-expand-btn', 'display', narrow), 'none');
  });

  it('the expand button is visible above 900px, so the narrow-media hide is a real override, not redundant', () => {
    assert.equal(decl('.sidebar-expand-btn', 'display'), 'flex');
  });

  it('narrow-screen topbar padding wins over the collapsed-sidebar padding at equal specificity, by source order', () => {
    // `.app.sidebar-collapsed .topbar` is declared both at top level (52px,
    // clearing the fixed expand button) and inside `@media (max-width: 900px)`
    // (20px, because the button is hidden there and needs no clearance).
    // Both selectors have identical specificity, so whichever rule sits later
    // in the stylesheet wins the cascade. If the narrow-media block were ever
    // moved above the base rule, the button-clearing 52px would win on mobile
    // even though the button itself is invisible there, wasting the padding
    // instead of breaking anything visually — but it would silently undo the
    // intent of the override. This locks the narrow-media rule to be last.
    const narrow = '@media (max-width: 900px)';
    const baseIndex = css.indexOf('.app.sidebar-collapsed .topbar { padding-left: 52px; }');
    const narrowRuleIndex = css.indexOf('.app.sidebar-collapsed .topbar { padding-left: 20px; }');
    assert.ok(baseIndex !== -1 && narrowRuleIndex !== -1, 'both padding-left declarations must be present verbatim');
    assert.ok(narrowRuleIndex > baseIndex, 'the narrow-media override must come after the base rule in source order');
    assert.equal(decl('.app.sidebar-collapsed .topbar', 'padding-left', narrow), '20px');
  });
});
