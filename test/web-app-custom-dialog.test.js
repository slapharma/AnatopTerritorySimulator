'use strict';
// The Custom meeting dialog (web/app.js): openCustomMeetingDialog and
// syncCustomRunMode set up #dlg-custom for either a discussion-scope custom
// meeting (run-mode choice, defaulting to "once") or a disagreement debate
// (run-mode hidden, forced to autopilot, auto-resolve row shown). Its submit
// handler (registered in init()) branches on that choice: "once" validates
// the agenda item and runs a plain custom turn per agent; "autopilot" builds
// the settings runAutopilot expects, instruction included. As in the other
// web/app.js vm tests, the relevant blocks are sliced out by string markers.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const ALL = ['regulatory', 'clinical', 'commercial'];
const LENGTH_LABELS = ['300 characters', '600 characters', '1,200 characters', '2,500 characters', 'As required'];
const LENGTH_VALUES = [300, 600, 1200, 2500, 'as_required'];

// A simple fake node: settable properties, a memoized child per selector
// string (so the same selector always resolves to the same fake node, as a
// real DOM would), and addEventListener capturing the last handler per type.
class FakeElement {
  constructor() {
    this.hidden = false; this.value = ''; this.checked = false; this.textContent = '';
    this.placeholder = ''; this.dataset = {};
    this._subEls = {};
  }

  querySelector(sel) {
    if (!(sel in this._subEls)) this._subEls[sel] = new FakeElement();
    return this._subEls[sel];
  }

  addEventListener(type, fn) { this[`_${type}`] = fn; }

  focus() {}

  showModal() {}
}

function loadHelpers() {
  const src = fs.readFileSync(WEB_APP_JS, 'utf8');
  const dialogStart = src.indexOf('  // Custom meeting and Autopilot share one dialog');
  const dialogEnd = src.indexOf('  // ---------------- reports ----------------');
  const submitStart = src.indexOf('    // Autopilot settings, inside the Custom meeting dialog');
  const submitEnd = src.indexOf('    // Agent Questions: discuss to resolution');
  assert.ok(dialogStart >= 0 && dialogEnd > dialogStart, 'markers not found — did openCustomMeetingDialog/syncCustomRunMode move?');
  assert.ok(submitStart >= 0 && submitEnd > submitStart, 'markers not found — did the #dlg-custom submit handler move?');

  // Every selector the sliced code touches resolves to a memoized top-level
  // fake node (radios/checkboxes seeded below with real values/checked state).
  const elements = {};
  const el = (sel) => { if (!(sel in elements)) elements[sel] = new FakeElement(); return elements[sel]; };
  // Pre-vivified so a test can set a value/checked/dataset on one of these
  // before the vm code under test has ever touched it.
  ['#dlg-custom', '#dlg-custom form', '#custom-title', '#custom-subtitle', '#custom-instruction',
    '#autopilot-auto-resolve-row', '#custom-run-mode', '#custom-autopilot', '#btn-custom-run',
    '#autopilot-length', '#autopilot-length-label', '#autopilot-interactions', '#autopilot-interactions-label',
    '#autopilot-stop-unanimous', '#autopilot-auto-resolve', '#autopilot-stances'].forEach(el);

  // Real radio inputs in the same name group auto-uncheck their siblings when
  // one is set .checked = true; the app's own code relies on that browser
  // behaviour (it only ever sets the one it wants true), so the fake has to
  // reproduce it for the assertions below to mean anything.
  const runModeRadios = {};
  for (const [key, initialChecked] of [['once', true], ['autopilot', false]]) {
    const node = new FakeElement();
    node.value = key;
    let checked = initialChecked;
    Object.defineProperty(node, 'checked', {
      get: () => checked,
      set: (v) => { checked = v; if (v) { for (const k of Object.keys(runModeRadios)) if (k !== key) runModeRadios[k]._setChecked(false); } },
    });
    node._setChecked = (v) => { checked = v; };
    runModeRadios[key] = node;
  }
  const agentChecks = ALL.map((a) => Object.assign(new FakeElement(), { value: a, checked: true }));
  const stanceSliders = []; // populated per test via ctx.stanceSliders

  const calls = { toasts: [], runSequence: [], runAutopilot: [] };
  const ctx = {
    ALL, LENGTH_LABELS, LENGTH_VALUES, STANCE_LABELS: [], setTimeout,
    state: { config: { stance_bank: {} } },
    toast: (msg) => { calls.toasts.push(msg); return undefined; },
    autopilotStanceRows: () => {},
    runSequence: async (turns) => calls.runSequence.push(turns),
    runAutopilot: async (settings) => calls.runAutopilot.push(settings),
    $: (sel) => {
      if (sel === "#custom-run-mode input[value=\"once\"]") return runModeRadios.once;
      if (sel === "#custom-run-mode input[value=\"autopilot\"]") return runModeRadios.autopilot;
      if (sel === '#custom-run-mode input:checked') return Object.values(runModeRadios).find((r) => r.checked) || null;
      if (sel === '#autopilot-stances') return el('#autopilot-stances');
      return el(sel);
    },
    $$: (sel, root) => {
      if (sel === '#custom-agents input') return agentChecks;
      if (sel === '#custom-agents input:checked') return agentChecks.filter((c) => c.checked);
      if (sel === '#custom-run-mode input') return Object.values(runModeRadios);
      if (sel === '.stance-slider') return root === el('#autopilot-stances') ? stanceSliders : [];
      return [];
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(dialogStart, dialogEnd)}
${src.slice(submitStart, submitEnd)}
this.openCustomMeetingDialog = openCustomMeetingDialog;
this.syncCustomRunMode = syncCustomRunMode;
this.customRunMode = customRunMode;`, ctx);
  ctx.calls = calls;
  ctx.elements = elements;
  ctx.runModeRadios = runModeRadios;
  ctx.agentChecks = agentChecks;
  ctx.stanceSliders = stanceSliders;
  return ctx;
}

describe('web/app.js openCustomMeetingDialog — discussion scope', () => {
  it('defaults the run-mode choice to "once", shows the choice, and hides the auto-resolve row', () => {
    const ctx = loadHelpers();

    ctx.openCustomMeetingDialog({ scope: 'discussion' });

    assert.equal(ctx.elements['#dlg-custom'].dataset.scope, 'discussion');
    assert.equal(ctx.elements['#custom-run-mode'].hidden, false);
    assert.equal(ctx.runModeRadios.once.checked, true);
    assert.equal(ctx.runModeRadios.autopilot.checked, false);
    assert.equal(ctx.elements['#autopilot-auto-resolve-row'].hidden, true);
  });
});

describe('web/app.js openCustomMeetingDialog — disagreement scope', () => {
  it('hides the run-mode choice, forces autopilot, and shows the auto-resolve row', () => {
    const ctx = loadHelpers();

    ctx.openCustomMeetingDialog({ scope: 'disagreement', disagreementN: 3, disagreementTopic: 'Pricing strategy' });

    assert.equal(ctx.elements['#dlg-custom'].dataset.scope, 'disagreement');
    assert.equal(ctx.elements['#dlg-custom'].dataset.disagreementN, 3);
    assert.equal(ctx.elements['#custom-run-mode'].hidden, true);
    assert.equal(ctx.runModeRadios.autopilot.checked, true);
    assert.equal(ctx.runModeRadios.once.checked, false);
    assert.equal(ctx.elements['#autopilot-auto-resolve-row'].hidden, false);
  });
});

describe('web/app.js syncCustomRunMode', () => {
  it('hides the autopilot settings and labels the button "Convene meeting" for "once"', () => {
    const ctx = loadHelpers();
    ctx.runModeRadios.once.checked = true; ctx.runModeRadios.autopilot.checked = false;

    ctx.syncCustomRunMode();

    assert.equal(ctx.elements['#custom-autopilot'].hidden, true);
    assert.equal(ctx.elements['#btn-custom-run'].textContent, 'Convene meeting');
    assert.match(ctx.elements['#custom-instruction'].placeholder, /Assume the dossier/);
  });

  it('shows the autopilot settings and labels the button "Start autopilot" for "autopilot"', () => {
    const ctx = loadHelpers();
    ctx.runModeRadios.once.checked = false; ctx.runModeRadios.autopilot.checked = true;

    ctx.syncCustomRunMode();

    assert.equal(ctx.elements['#custom-autopilot'].hidden, false);
    assert.equal(ctx.elements['#btn-custom-run'].textContent, 'Start autopilot');
    assert.match(ctx.elements['#custom-instruction'].placeholder, /Optional: the point to debate/);
  });
});

describe('web/app.js #dlg-custom submit handler', () => {
  it('ignores a submit whose submitter is not the "run" button (e.g. Cancel)', () => {
    const ctx = loadHelpers();
    const e = { submitter: { value: 'cancel' }, preventDefault: () => { throw new Error('must not be called'); } };

    ctx.elements['#dlg-custom form']._submit(e);

    assert.equal(ctx.calls.runSequence.length, 0);
    assert.equal(ctx.calls.runAutopilot.length, 0);
  });

  it('toasts and prevents default when no agents are picked', () => {
    const ctx = loadHelpers();
    ctx.agentChecks.forEach((c) => { c.checked = false; });
    let prevented = false;
    const e = { submitter: { value: 'run' }, preventDefault: () => { prevented = true; } };

    ctx.elements['#dlg-custom form']._submit(e);

    assert.equal(prevented, true);
    assert.match(ctx.calls.toasts[0], /Pick at least one agent/);
    assert.equal(ctx.calls.runSequence.length, 0);
  });

  it('"once" with an empty agenda item toasts and prevents default, running nothing', () => {
    const ctx = loadHelpers();
    ctx.elements['#custom-instruction'].value = '   ';
    let prevented = false;
    const e = { submitter: { value: 'run' }, preventDefault: () => { prevented = true; } };

    ctx.elements['#dlg-custom form']._submit(e);

    assert.equal(prevented, true);
    assert.match(ctx.calls.toasts[0], /Write an agenda item first/);
    assert.equal(ctx.calls.runSequence.length, 0);
  });

  it('"once" runs a plain custom turn per checked agent, carrying the trimmed instruction', async () => {
    const ctx = loadHelpers();
    ctx.elements['#custom-instruction'].value = '  Re-state your launch timeline.  ';
    const e = { submitter: { value: 'run' }, preventDefault: () => {} };

    ctx.elements['#dlg-custom form']._submit(e);
    await new Promise((r) => setTimeout(r, 5)); // the handler defers the run with setTimeout(fn, 0)

    assert.equal(ctx.calls.runSequence.length, 1);
    const turns = ctx.calls.runSequence[0];
    assert.deepEqual(turns.map((t) => t.speaker), ALL);
    for (const t of turns) {
      assert.equal(t.mode, 'custom');
      assert.equal(t.instruction, 'Re-state your launch timeline.');
    }
    assert.equal(ctx.calls.runAutopilot.length, 0);
  });

  it('"autopilot" builds runAutopilot settings, including the (untrimmed-required) instruction', async () => {
    const ctx = loadHelpers();
    ctx.runModeRadios.once.checked = false; ctx.runModeRadios.autopilot.checked = true;
    ctx.elements['#dlg-custom'].dataset.scope = 'discussion';
    ctx.elements['#dlg-custom'].dataset.disagreementN = '';
    ctx.elements['#custom-instruction'].value = 'Debate the pricing floor.';
    ctx.elements['#autopilot-length'].value = '2';
    ctx.elements['#autopilot-interactions'].value = '8';
    ctx.elements['#autopilot-stop-unanimous'].checked = true;
    ctx.elements['#autopilot-auto-resolve'].checked = false;
    const e = { submitter: { value: 'run' }, preventDefault: () => {} };

    ctx.elements['#dlg-custom form']._submit(e);
    await new Promise((r) => setTimeout(r, 5));

    assert.equal(ctx.calls.runSequence.length, 0);
    assert.equal(ctx.calls.runAutopilot.length, 1);
    const settings = ctx.calls.runAutopilot[0];
    assert.equal(settings.instruction, 'Debate the pricing floor.');
    assert.equal(settings.scope, 'discussion');
    assert.deepEqual(settings.agents, ALL);
    assert.equal(settings.max_chars, 1200); // LENGTH_VALUES[2]
    assert.equal(settings.interactions, 8);
    assert.equal(settings.stopOnUnanimous, true);
    assert.equal(settings.autoResolve, false);
  });

  it('"once" leaves the agenda item empty as allowed for autopilot: an empty instruction still starts the run (optional there)', async () => {
    const ctx = loadHelpers();
    ctx.runModeRadios.once.checked = false; ctx.runModeRadios.autopilot.checked = true;
    ctx.elements['#custom-instruction'].value = '';
    const e = { submitter: { value: 'run' }, preventDefault: () => {} };

    ctx.elements['#dlg-custom form']._submit(e);
    await new Promise((r) => setTimeout(r, 5));

    assert.equal(ctx.calls.runAutopilot.length, 1);
    assert.equal(ctx.calls.runAutopilot[0].instruction, '');
  });
});
