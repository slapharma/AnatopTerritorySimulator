'use strict';
// Static structural checks on web/index.html and web/admin.html: the old
// standalone Autopilot dialog/button and the dashboard's action tiles were
// folded into the Custom meeting dialog and the sidebar's own buttons, the
// Knowledgebase tab moved from Admin into every evaluation's Intelligence
// sidebar, and Disagreements moved from the Evidence group to the Panel
// group. Plain string/regex assertions against the markup, in the style of
// test/web-styles-restored.test.js — no DOM parser involved.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const indexHtml = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const adminHtml = fs.readFileSync(path.join(WEB, 'admin.html'), 'utf8');

describe('web/index.html — removed elements', () => {
  it('has no #btn-autopilot (Autopilot is reached through the Custom meeting dialog now)', () => {
    assert.doesNotMatch(indexHtml, /id="btn-autopilot"/);
  });

  it('has no #dlg-autopilot (merged into #dlg-custom)', () => {
    assert.doesNotMatch(indexHtml, /id="dlg-autopilot"/);
  });

  it('has no #dash-actions (the dashboard start/resume tiles were replaced by sidebar buttons)', () => {
    assert.doesNotMatch(indexHtml, /id="dash-actions"/);
  });
});

describe('web/index.html — #btn-all-evals', () => {
  it('sits inside .side-actions, alongside #btn-new, styled as btn-primary', () => {
    const block = indexHtml.match(/<div class="side-actions">[\s\S]*?<\/div>/);
    assert.ok(block, '.side-actions block not found');
    assert.match(block[0], /id="btn-new"/);
    assert.match(block[0], /id="btn-all-evals"[^>]*class="btn btn-primary[^"]*"/);
  });
});

describe('web/index.html — Intelligence sidebar nav grouping', () => {
  // Extract each "<div class="side-subhead">Name</div>...items..." run up to
  // the next side-subhead (or the end of the nav body).
  function navGroups() {
    const body = indexHtml.match(/<div class="side-section-body side-nav" id="intel-nav-body">([\s\S]*?)<\/div>\s*\n\s*<\/nav>/);
    assert.ok(body, 'intel-nav-body not found');
    const groups = {};
    const re = /<div class="side-subhead">([^<]+)<\/div>([\s\S]*?)(?=<div class="side-subhead">|$)/g;
    let m;
    while ((m = re.exec(body[1]))) groups[m[1]] = m[2];
    return groups;
  }

  it('puts Disagreements in the Panel group, not Evidence', () => {
    const groups = navGroups();
    assert.ok(groups.Evidence, 'no Evidence group found');
    assert.ok(groups.Panel, 'no Panel group found');
    assert.doesNotMatch(groups.Evidence, /data-pane="disagreements"/);
    assert.match(groups.Panel, /data-pane="disagreements"/);
  });

  it('puts Knowledgebase in the Evidence group', () => {
    const groups = navGroups();
    assert.match(groups.Evidence, /data-pane="knowledgebase"/);
  });
});

describe('web/index.html — #intel-page-select', () => {
  it('has a knowledgebase option', () => {
    const select = indexHtml.match(/<select id="intel-page-select">[\s\S]*?<\/select>/);
    assert.ok(select, '#intel-page-select not found');
    assert.match(select[0], /<option value="knowledgebase">Knowledgebase<\/option>/);
  });
});

describe('web/admin.html — knowledgebase removed', () => {
  it('no longer contains the #kb-content section', () => {
    assert.doesNotMatch(adminHtml, /id="kb-content"/);
  });

  it('no longer defines renderKnowledge', () => {
    assert.doesNotMatch(adminHtml, /function renderKnowledge/);
  });
});
