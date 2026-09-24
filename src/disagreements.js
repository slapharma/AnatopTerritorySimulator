'use strict';
// ⚠ DISAGREEMENT blocks in agent text, and the open-disagreement section the
// app writes into meeting minutes. Pure, so src/app.js and
// scripts/simulate-session.js log exactly the same disagreements.

// A block starts at ⚠ (with or without the emoji variation selector the model
// sometimes adds) and runs to the first Status line, over blank lines, which
// the FORMATTING RULES require between Position A/B/Status. Case, bold markers
// on either side of the colon, a dash instead of a colon, and a missing word
// DISAGREEMENT are all tolerated: the UI draws a ⚠ box for any of them, so the
// log has to see the same blocks the moderator sees. It must reach Status
// within 1,500 characters and without passing another ⚠, so a stray warning
// sign cannot take over the next real block. The gap after "Status" is one
// character class, not several optional runs in a row, which backtracked
// catastrophically on long whitespace (21 s for 400 spaces).
const DIS_RE = /⚠️?(?:(?!⚠)[\s\S]){0,1500}?Status[\s*]*(?:[:—–-][\s*]*)?(?:PARTIALLY\s+)?(?:UN)?RESOLVED[^\n]*/gi;

// The topic from the block's first line: the ⚠, the word DISAGREEMENT, any
// #n, separators, brackets, bold, a trailing "(Status: …)" and anything from
// "Position A" on (a block collapsed onto one line) all removed.
function disagreementTopic(head) {
  const t = String(head || '')
    .replace(/⚠️?/g, '')
    .replace(/\(?[\s*]*Status[\s\S]*$/i, '')
    .replace(/[\s*]*Position\s+A\b[\s\S]*$/i, '')
    .replace(/DISAGREEMENT\b/i, '')
    .replace(/^[\s*_]*#?\s*\d+\s*(?=[—–:-])/, '')
    .replace(/[*_[\]]/g, '')
    .replace(/^\s*[—–:-]+\s*/, '')
    .replace(/\s*[—–:-]+\s*$/, '')
    .trim();
  return t || 'untitled';
}

// RESOLVED only when the Status line starts with it and says nothing else
// open: "RESOLVED (how) / UNRESOLVED" copied from the template, or "PARTIALLY
// RESOLVED", is still open.
function disagreementStatus(block) {
  const m = String(block || '').match(/Status[ \t*]*(?:[:—–-][ \t*]*)?([^\n]*)/i);
  const line = m ? m[1] : '';
  return /^RESOLVED\b/i.test(line) && !/UNRESOLVED|PARTIAL/i.test(line) ? 'resolved' : 'unresolved';
}

// [{ topic, status, block }] in message order.
function parseDisagreements(text) {
  return [...String(text || '').matchAll(DIS_RE)].map((m) => {
    const block = m[0].trim();
    return { topic: disagreementTopic(block.split('\n')[0]), status: disagreementStatus(block), block };
  });
}

// The minutes' open-disagreement section, from the log rather than a model's
// reading of the transcript: model-written minutes reported "None" under two
// open challenges in the 2026-09-24 audit.
function openDisagreementsMarkdown(disagreements) {
  const open = (disagreements || []).filter((d) => d.status !== 'resolved');
  const log = open.length ? open.map((d) => `- #${d.n} ${d.topic} — UNRESOLVED`).join('\n') : 'None.';
  return `## Open disagreements\n\n${log}`;
}

// Removes a section a model was told not to write: a heading, or a bold
// "**Open disagreements:**" line, down to the next heading of the same or a
// higher level, so the app's version is the only one.
function dropSection(text, nameRe) {
  const out = [];
  let skipLevel = 0;
  for (const line of String(text || '').split('\n')) {
    // Linear on purpose: a lazy capture between optional whitespace runs
    // backtracked cubically on a heading padded with spaces (142 s at 8,000).
    const h = line.match(/^(#{1,6})[ \t]+(.*)$/);
    let name = h ? h[2].trimEnd() : '';
    while (name.endsWith('#')) name = name.slice(0, -1).trimEnd();
    if (skipLevel && h && h[1].length <= skipLevel) skipLevel = 0;
    if (!skipLevel) {
      if (h && nameRe.test(name.replace(/[*_]/g, '').trim())) { skipLevel = h[1].length; continue; }
      if (!h && nameRe.test(line.replace(/[*_]/g, '').trim())) { skipLevel = 7; continue; }
    }
    if (!skipLevel) out.push(line);
  }
  return out.join('\n');
}

module.exports = { DIS_RE, disagreementTopic, disagreementStatus, parseDisagreements, openDisagreementsMarkdown, dropSection };
