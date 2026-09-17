'use strict';
// One Intelligence tab as a document. Each builder turns the full session
// (db.fullSession) into { title, markdown }; src/export.js renders that to Word
// or PDF with the same cover and typography as a generated report. Markdown is
// the hand-off because the exporters already render it faithfully, tables and
// links included, so a new tab here needs no change there.
const prompts = require('./prompts');
const { speakerName, fmtUTC } = require('./export');

// The names the app shows for each meeting (web/app.js MODE_LABEL), so an
// exported tab uses the same words as the page it came from.
const MODE_LABEL = {
  opening: 'Baselines', round2: 'Challenge', round3: 'Converge', crosstalk: 'Cross-talk', reply: 'Reply', custom: 'Custom meeting',
  decision: 'Decision output', dive_deeper: 'Dive Deeper', autopilot: 'Autopilot', meeting_minutes: 'Meeting minutes', report: 'Report',
};
const modeLabel = (mode) => MODE_LABEL[mode] || mode || '';

const QUESTION_STATUS = { open: 'Open', answered: 'Answered', resolved: 'Resolved', escalated: 'Escalated to moderator' };
const KIND_LABEL = { interim: 'Interim report', final: 'Final report' };
const DEPTH_LABEL = { brief: 'Brief', standard: 'Standard', full: 'Full' };

// Square brackets and pipes in stored text would be read as a citation, a link
// or a table cell by src/markdown-blocks.js; round brackets are fine.
const safe = (t) => String(t ?? '').replace(/\[/g, '(').replace(/\]/g, ')').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
const party = (k) => (k === 'moderator' ? 'Moderator' : prompts.AGENTS[k] ? prompts.AGENTS[k].label : k);
const empty = (text) => `_${text}_`;

function messageBlock(m, heading = `${speakerName(m)} · ${modeLabel(m.mode)} · #${m.seq}`) {
  return `### ${safe(heading)}\n\n${m.error ? empty(`Turn failed: ${safe(m.error)}`) : (m.text || '')}`;
}

function sources(s) {
  const cited = s.sources.filter((x) => x.kind === 'cited');
  const searched = s.sources.length - cited.length;
  const lines = cited.map((x) => {
    const by = [...new Set((x.cited_by || []).map((c) => party(c.speaker)))].join(', ');
    return `- **${x.n}.** [${safe(x.title || x.url)}](${String(x.url).replace(/\(/g, '%28').replace(/\)/g, '%29')}) · cited ${fmtUTC(x.first_cited_at)}${by ? ` · ${by}` : ''}`;
  });
  return [
    lines.length ? lines.join('\n') : empty('No sources have been cited in a claim yet.'),
    searched ? empty(`${searched} additional page(s) were searched but not cited in any claim.`) : '',
  ].filter(Boolean).join('\n\n');
}

function disagreements(s) {
  if (!s.disagreements.length) return empty('No disagreements were logged.');
  return s.disagreements.map((d) => `## #${d.n} ${safe(d.topic)} — ${String(d.status).toUpperCase()}\n\n${d.body || ''}`).join('\n\n');
}

function questionBlock(q, s) {
  const asked = s.messages.find((m) => String(m.id) === String(q.message_id));
  const to = String(q.addressees || '').split(',').filter(Boolean).map(party).join(', ');
  const meta = [
    `**Status:** ${QUESTION_STATUS[q.status] || q.status}`,
    `**Asked in:** ${modeLabel(q.round) || 'the transcript'}${asked ? ` (#${asked.seq})` : ''}`,
    q.resolution_note ? `**Outcome:** ${safe(q.resolution_note)}` : '',
  ].filter(Boolean).join(' · ');
  return `### ${safe(party(q.asker))} → ${safe(to)}\n\n${safe(q.text)}\n\n${meta}`;
}

function questions(s) {
  const list = s.questions || [];
  if (!list.length) return empty('No questions logged yet.');
  // Grouped by status, open first, so the export reads as a to-do list.
  return ['open', 'escalated', 'answered', 'resolved']
    .map((st) => [st, list.filter((q) => q.status === st)])
    .filter(([, rows]) => rows.length)
    .map(([st, rows]) => `## ${QUESTION_STATUS[st]} (${rows.length})\n\n${rows.map((q) => questionBlock(q, s)).join('\n\n')}`)
    .join('\n\n');
}

function escalations(s) {
  const list = (s.questions || []).filter((q) => q.status === 'escalated');
  return list.length ? list.map((q) => questionBlock(q, s)).join('\n\n') : empty('Nothing is escalated.');
}

// The Decision tab holds the recommendation and every report generated for it.
function decision(s) {
  const reports = s.reports || [];
  return [
    '## Decision output',
    s.decision_text || empty('No decision output has been written for this session yet.'),
    '## Reports',
    reports.length
      ? reports.map((r) => `### ${KIND_LABEL[r.kind] || r.kind} · ${DEPTH_LABEL[r.depth] || r.depth} · ${fmtUTC(r.created_at)}\n\n${r.text || ''}`).join('\n\n')
      : empty('No reports generated yet.'),
  ].join('\n\n');
}

function favourites(s) {
  const list = s.messages.filter((m) => m.favourite && m.role !== 'system');
  return list.length ? list.map((m) => messageBlock(m)).join('\n\n') : empty('No favourites yet.');
}

function minutes(s) {
  const list = s.meeting_minutes || [];
  if (!list.length) return empty('No minutes yet.');
  return list.map((mm, i) => {
    const state = mm.round === 'question' ? '' : ` — ${mm.approved ? 'Approved' : 'Pending approval'}`;
    return `## ${i + 1}. ${safe(mm.label)}${state}\n\n${empty(fmtUTC(mm.created_at))}\n\n${mm.text || ''}`;
  }).join('\n\n');
}

// Agent notes has four cuts on screen; the export follows the one in view.
function agentNotes(s, { cut } = {}) {
  const spoken = s.messages.filter((m) => m.role !== 'system' && !m.error && m.text != null);
  const who = (m) => (m.role === 'user' ? 'user' : m.speaker);
  if (cut === 'disagreement' || cut === 'resolution') {
    if (!s.disagreements.length) return empty('No disagreements logged.');
    const line = (d) => `- **#${d.n}** ${safe(d.topic)}${cut === 'disagreement' ? ` — ${String(d.status).toUpperCase()}` : ''}`;
    if (cut === 'disagreement') return s.disagreements.map(line).join('\n');
    const resolved = s.disagreements.filter((d) => d.status === 'resolved');
    const unresolved = s.disagreements.filter((d) => d.status !== 'resolved');
    return `## Unresolved (${unresolved.length})\n\n${unresolved.map(line).join('\n') || empty('None.')}\n\n## Resolved (${resolved.length})\n\n${resolved.map(line).join('\n') || empty('None.')}`;
  }
  const groups = new Map();
  for (const m of spoken) {
    const key = cut === 'meeting' ? (m.mode || 'other') : who(m);
    const label = cut === 'meeting' ? (modeLabel(m.mode) || 'Other') : speakerName(m);
    if (!groups.has(key)) groups.set(key, { label, rows: [] });
    groups.get(key).rows.push(m);
  }
  if (!groups.size) return empty('No messages yet.');
  return [...groups.values()].map((g) => `## ${safe(g.label)} (${g.rows.length})\n\n${g.rows.map((m) => messageBlock(m,
    cut === 'meeting' ? `${speakerName(m)} · #${m.seq}` : `${modeLabel(m.mode)} · #${m.seq}`)).join('\n\n')}`).join('\n\n');
}

function inputs(s) {
  const rows = prompts.INPUT_FIELDS.map((f) => `| ${safe(f.label)} | ${safe((s.inputs[f.key] || '').trim()) || '_INPUT MISSING_'} |`);
  return `| Input | Value |\n|---|---|\n${rows.join('\n')}`;
}

const SECTIONS = {
  sources: { title: 'Sources', build: sources },
  disagreements: { title: 'Disagreements', build: disagreements },
  intelligence: { title: 'Agent notes', build: agentNotes },
  questions: { title: 'Agent Questions', build: questions },
  escalations: { title: 'Escalations', build: escalations },
  decision: { title: 'Decision and reports', build: decision },
  favourites: { title: 'Favourites', build: favourites },
  minutes: { title: 'Minutes', build: minutes },
  inputs: { title: 'Inputs', build: inputs },
};

// null for a section this module does not know, so the route can 404.
function sectionDoc(s, section, opts = {}) {
  const def = Object.hasOwn(SECTIONS, section) ? SECTIONS[section] : null;
  return def ? { key: section, title: def.title, markdown: def.build(s, opts) } : null;
}

// ---------- single items ----------
// One thing on the page (a report, a minutes entry, a meeting's transcript, a
// response, a disagreement, a question) as { title, markdown }, for its View
// modal and its Word / PDF / Excel downloads. A report also carries the row,
// so Word and PDF keep the report cover. A meeting transcript carries `table`,
// so Excel gets one row per response rather than one per paragraph.
// null when the key names nothing in this session.
const TRANSCRIPT_COLUMNS = [
  { header: '#', width: 6 }, { header: 'Speaker', width: 24 }, { header: 'Meeting', width: 16 },
  { header: 'Time (UTC)', width: 20 }, { header: 'Response', width: 100 },
];
const ITEM_KINDS = {
  report(s, key) {
    const r = (s.reports || []).find((x) => String(x.id) === key);
    return r && { title: `${KIND_LABEL[r.kind] || r.kind} · ${DEPTH_LABEL[r.depth] || r.depth}`, markdown: r.text || '', report: r };
  },
  decision(s) {
    return s.decision_text ? { title: 'Decision output', markdown: s.decision_text } : null;
  },
  minutes(s, key) {
    const mm = (s.meeting_minutes || []).find((x) => String(x.id) === key);
    if (!mm) return null;
    const state = mm.round === 'question' ? '' : ` · ${mm.approved ? 'Approved' : 'Pending approval'}`;
    return { title: `Minutes: ${safe(mm.label)}`, markdown: `${empty(`${fmtUTC(mm.created_at)}${state}`)}\n\n${mm.text || ''}` };
  },
  // Every response in one standard meeting, in order.
  meeting(s, key) {
    if (!['opening', 'round2', 'round3', 'crosstalk'].includes(key)) return null;
    const list = s.messages.filter((m) => m.mode === key && m.role !== 'system');
    return {
      title: `Transcript: ${modeLabel(key)}`,
      markdown: list.length ? list.map((m) => messageBlock(m)).join('\n\n') : empty('No responses in this meeting yet.'),
      table: {
        columns: TRANSCRIPT_COLUMNS,
        rows: list.map((m) => [m.seq, speakerName(m), modeLabel(m.mode), fmtUTC(m.created_at), m.error ? `Turn failed: ${m.error}` : (m.text || '')]),
      },
    };
  },
  message(s, key) {
    const m = s.messages.find((x) => String(x.id) === key);
    return m && { title: `${speakerName(m)} · ${modeLabel(m.mode)} · #${m.seq}`, markdown: m.error ? empty(`Turn failed: ${safe(m.error)}`) : (m.text || '') };
  },
  disagreement(s, key) {
    const d = s.disagreements.find((x) => String(x.n) === key);
    return d && { title: `Disagreement #${d.n}: ${safe(d.topic)}`, markdown: `**Status:** ${String(d.status).toUpperCase()}\n\n${d.body || ''}` };
  },
  question(s, key) {
    const q = (s.questions || []).find((x) => String(x.id) === key);
    return q && { title: `Question: ${safe(party(q.asker))}`, markdown: questionBlock(q, s) };
  },
};

function itemDoc(s, kind, key) {
  const build = Object.hasOwn(ITEM_KINDS, kind) ? ITEM_KINDS[kind] : null;
  return build ? build(s, String(key)) || null : null;
}

module.exports = { sectionDoc, SECTIONS, itemDoc, ITEM_KINDS };
