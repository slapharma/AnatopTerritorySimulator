'use strict';
// Tiny Markdown parser used by the exporters. Produces a flat list of blocks:
//   {type:'heading', level, runs} | {type:'para', runs} | {type:'bullet', ordered, runs}
//   {type:'table', rows:[[runs,...],...]} | {type:'code', text} | {type:'disagreement', runs}
// runs: [{text, bold, italic, code, badge:'verified'|'estimate'|'unknown', cite:n, link}]

const BADGE_RE = /\[(VERIFIED|ESTIMATE|UNKNOWN)\b\s*[—–:-]?\s*([^\]]*)\]/;

function parseInline(s) {
  const runs = [];
  const re = /(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(`[^`]+`)|(\[(?:VERIFIED|ESTIMATE|UNKNOWN)\b[^\]]*\])|(\[\d+\])|(\[[^\]]+\]\((https?:[^)\s]+)\))/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > last) runs.push({ text: s.slice(last, m.index) });
    const tok = m[0];
    if (m[1]) runs.push({ text: tok.slice(2, -2), bold: true });
    else if (m[2] || m[3]) runs.push({ text: tok.slice(1, -1), italic: true });
    else if (m[4]) runs.push({ text: tok.slice(1, -1), code: true });
    else if (m[5]) {
      const b = tok.match(BADGE_RE);
      runs.push({ text: tok, badge: b[1].toLowerCase(), badgeDetail: (b[2] || '').trim() });
    } else if (m[6]) runs.push({ text: tok, cite: Number(tok.slice(1, -1)) });
    else if (m[7]) {
      const inner = tok.match(/^\[([^\]]+)\]\((https?:[^)\s]+)\)$/);
      runs.push({ text: inner[1], link: inner[2] });
    }
    last = m.index + tok.length;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return runs.length ? runs : [{ text: '' }];
}

function parseBlocks(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let table = null;
  let code = null;
  const flushPara = () => { if (para.length) { blocks.push({ type: 'para', runs: parseInline(para.join(' ')) }); para = []; } };
  const flushTable = () => { if (table) { blocks.push({ type: 'table', rows: table }); table = null; } };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (code) {
      if (/^```/.test(line)) { blocks.push({ type: 'code', text: code.join('\n') }); code = null; } else code.push(raw);
      continue;
    }
    if (/^```/.test(line)) { flushPara(); flushTable(); code = []; continue; }
    if (!line.trim()) { flushPara(); flushTable(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushTable(); blocks.push({ type: 'heading', level: h[1].length, runs: parseInline(h[2].replace(/\s#+$/, '')) }); continue; }
    if (/^\s*\|/.test(line)) {
      flushPara();
      if (/^\s*\|?\s*:?-{2,}/.test(line)) continue; // separator row
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => parseInline(c.trim()));
      if (!table) table = [];
      table.push(cells);
      continue;
    }
    flushTable();
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) { flushPara(); blocks.push({ type: 'bullet', ordered: /\d/.test(li[2]), level: Math.min(3, Math.floor(li[1].length / 2)), runs: parseInline(li[3]) }); continue; }
    if (/^\s*⚠/.test(line)) { flushPara(); blocks.push({ type: 'disagreement', runs: parseInline(line.trim()) }); continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flushPara(); continue; }
    para.push(line.trim());
  }
  flushPara(); flushTable();
  if (code) blocks.push({ type: 'code', text: code.join('\n') });
  return blocks;
}

function plain(runs) { return runs.map((r) => r.text).join(''); }

module.exports = { parseBlocks, parseInline, plain, BADGE_RE };
