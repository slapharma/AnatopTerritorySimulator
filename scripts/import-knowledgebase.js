// Imports "agent knowledgebase/drive-document-index.md" into the knowledge_items
// table that feeds prompts.knowledgeBlock() — the curated Drive index the agents
// are told about at the start of every turn.
//
// The markdown file is the source of truth and is reviewable in git; the table is
// what the app actually reads. Without this the two drift silently, because rows
// could only be typed in one at a time on the Admin page.
//
//   node scripts/import-knowledgebase.js            # dry run, prints the plan
//   node scripts/import-knowledgebase.js --json     # dry run, prints the parsed rows
//   node scripts/import-knowledgebase.js --apply    # writes
//
// Idempotent, keyed on the Drive URL: an existing row is updated in place when
// its title/category/note/sensitive drifted, and left alone when it matches.
// Rows whose URL is no longer in the markdown are reported but never deleted —
// they may have been added by hand on the Admin page.
//
// --apply writes the whole table to a timestamped JSON backup next to this file
// before changing anything, so a bad import can be reversed.
'use strict';
require('../src/bootstrap');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const SOURCE = path.join(__dirname, '..', 'agent knowledgebase', 'drive-document-index.md');
const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
// "Skipped / low relevance" is an explicit not-listed note and carries no rows.
// "Handle with care" holds the commercial-in-confidence documents: its rows import
// like any other, with sensitive set, under a short category of their own rather
// than the section's long prose heading. The flag is a label for the humans on the
// Admin page — prompts.knowledgeBlock() does not restrict the agents on it. Any
// name still written there without a link is collected too, so it can flag a
// matching row imported from elsewhere.
const SKIP_SECTION = /^Skipped \/ low relevance/i;
const SENSITIVE_SECTION = /^Handle with care/i;
const SENSITIVE_CATEGORY = 'Commercial — pricing, forecasts and partner terms';

const NOTE_MAX = 240;

// Strips the separators that join a link to its note ("— ...", ", ...", "; ...",
// "/ ...", ": ...") and any dangling bracket left by a parenthesised link.
function cleanNote(raw) {
  return String(raw || '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^[\s—–\-,;:/.()]+/, '')
    .replace(/[\s—–\-,;:/]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
    .trim()
    .slice(0, NOTE_MAX);
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function parse(markdown) {
  const lines = markdown.split(/\r?\n/);
  const rows = [];
  const sensitiveNames = [];
  let heading = null;
  let inSkip = false;
  let inSensitive = false;

  for (const line of lines) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      heading = h[1].trim();
      inSkip = SKIP_SECTION.test(heading);
      inSensitive = SENSITIVE_SECTION.test(heading);
      continue;
    }
    if (!heading || inSkip) continue;
    if (inSensitive) for (const m of line.matchAll(/`([^`]+)`/g)) sensitiveNames.push(m[1]);

    const links = [...line.matchAll(LINK)];
    if (!links.length) continue;

    // A leading **Bold** is a country, partner or archive name — it groups the
    // links on that line, so it becomes part of the category rather than being
    // dropped. Leading dots are Drive's "sort me first" convention, not content.
    const boldPrefix = /^\s*(?:[-*]\s*)?\*\*(.+?)\*\*/.exec(line);
    const sub = boldPrefix ? boldPrefix[1].replace(/^\.+/, '').replace(/[:\s]+$/, '').trim() : null;
    const base = sub ? heading.replace(/\s*\([^)]*\)\s*$/, '').trim() : heading;
    const category = inSensitive ? SENSITIVE_CATEGORY : (sub ? `${base} — ${sub}` : base);

    const leadIn = cleanNote(line.slice(boldPrefix ? boldPrefix[0].length : 0, links[0].index));
    const trailing = cleanNote(line.slice(links[links.length - 1].index + links[links.length - 1][0].length));

    links.forEach((m, idx) => {
      const next = links[idx + 1];
      const own = cleanNote(line.slice(m.index + m[0].length, next ? next.index : undefined));
      rows.push({
        category,
        title: m[1].trim(),
        url: m[2].trim(),
        note: own || trailing || leadIn || '',
        sensitive: inSensitive,
      });
    });
  }

  // Same document listed under two headings (a GMP template filed under both
  // Ireland and its Nordics partner, say): one row, with the other placements
  // recorded in the note rather than a duplicate the agents would read twice.
  const byUrl = new Map();
  for (const r of rows) {
    const existing = byUrl.get(r.url);
    if (!existing) { byUrl.set(r.url, r); continue; }
    // Sensitivity is the union, never the first occurrence: a document listed
    // in a normal section and again under "handle with care" is sensitive.
    existing.sensitive = existing.sensitive || r.sensitive;
    if (existing.category !== r.category && !existing.alsoIn) existing.alsoIn = [];
    if (existing.category !== r.category && !existing.alsoIn.includes(r.category)) existing.alsoIn.push(r.category);
  }
  const deduped = [...byUrl.values()].map((r) => {
    const also = r.alsoIn && r.alsoIn.length ? `also filed under: ${r.alsoIn.join('; ')}` : '';
    const note = [r.note, also].filter(Boolean).join(' · ').slice(0, NOTE_MAX);
    return { category: r.category, title: r.title, url: r.url, note, sensitive: r.sensitive };
  });

  // Second path to the flag, for a name still written in that section without a
  // link: match it by title against rows imported from the other sections.
  const normNames = sensitiveNames.map(norm).filter((n) => n.length >= 12);
  for (const r of deduped) {
    const t = norm(r.title);
    if (normNames.some((n) => t.includes(n) || n.includes(t))) r.sensitive = true;
  }

  return { rows: deduped, sensitiveNames, skippedLinkless: sensitiveNames.length };
}

const same = (a, b) => a.category === b.category && a.title === b.title && (a.note || '') === (b.note || '') && Boolean(a.sensitive) === Boolean(b.sensitive);

async function main() {
  const apply = process.argv.includes('--apply');
  const { rows, sensitiveNames } = parse(fs.readFileSync(SOURCE, 'utf8'));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 1));
    await db.pool.end();
    return;
  }

  const existing = await db.listKnowledgeItems();
  // Several rows can share a URL (an earlier import filed the same document
  // under two headings). The lowest id is the one the import keeps and updates;
  // the rest are exact duplicates of a document this import already owns, and
  // the surviving row's note records every heading it appears under.
  const byUrl = new Map();
  for (const r of existing) {
    const prev = byUrl.get(r.url);
    if (!prev || Number(r.id) < Number(prev.id)) byUrl.set(r.url, r);
  }
  const urls = new Set(rows.map((r) => r.url));
  const duplicates = existing.filter((r) => byUrl.get(r.url) !== r && urls.has(r.url));

  const create = rows.filter((r) => !byUrl.has(r.url));
  const update = rows.filter((r) => byUrl.has(r.url) && !same(r, byUrl.get(r.url)));
  const unchanged = rows.length - create.length - update.length;
  const orphans = existing.filter((r) => !urls.has(r.url));

  const byCategory = new Map();
  for (const r of rows) byCategory.set(r.category, (byCategory.get(r.category) || 0) + 1);

  console.log(`Source:   ${SOURCE}`);
  console.log(`Parsed:   ${rows.length} documents across ${byCategory.size} categories`);
  for (const [c, n] of byCategory) console.log(`            ${String(n).padStart(3)}  ${c}`);
  console.log(`Sensitive flagged: ${rows.filter((r) => r.sensitive).length} of ${rows.length}`);
  console.log(`\nIn the table already: ${existing.length}`);
  console.log(`  create ${create.length} · update ${update.length} · unchanged ${unchanged} · duplicate rows to remove ${duplicates.length} · not in the markdown ${orphans.length} (left alone)`);
  if (orphans.length) for (const o of orphans) console.log(`            keep  [${o.category}] ${o.title}`);
  if (duplicates.length) for (const d of duplicates) console.log(`            drop  #${d.id} [${d.category}] ${d.title}`);

  const linkedTitles = new Set(rows.map((r) => norm(r.title)));
  const unlinked = sensitiveNames.filter((n) => ![...linkedTitles].some((t) => t.includes(norm(n)) || norm(n).includes(t)));
  console.log(`\nSensitive files still named without a Drive link: ${unlinked.length}`);
  for (const n of unlinked) console.log(`            ${n}`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.');
    await db.pool.end();
    return;
  }

  const backup = path.join(__dirname, `knowledgebase-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backup, JSON.stringify(existing, null, 1), 'utf8');
  console.log(`\nBacked up all ${existing.length} rows to ${backup}`);

  for (const r of create) await db.createKnowledgeItem(r);
  for (const r of update) await db.updateKnowledgeItem(byUrl.get(r.url).id, r);
  for (const d of duplicates) await db.deleteKnowledgeItem(d.id);
  console.log(`Wrote ${create.length} new and ${update.length} updated rows; removed ${duplicates.length} duplicates.`);
  console.log(`Table now holds ${(await db.listKnowledgeItems()).length} rows.`);
  await db.pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
