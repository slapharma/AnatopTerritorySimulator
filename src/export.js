'use strict';
const path = require('path');
const docx = require('docx');
const pdfmake = require('pdfmake');
const { parseBlocks, plain } = require('./markdown-blocks');
const prompts = require('./prompts');

const FONT_DIR = path.join(__dirname, '..', 'fonts');
const FONT = 'Montserrat';
const COLOURS = {
  regulatory: '1D4ED8', clinical: '0F766E', commercial: '6D28D9', moderator: '334155', user: 'B45309',
  verified: '166534', estimate: '92400E', unknown: '4B5563', link: '0891B2', muted: '64748B',
};

function fileName(s) {
  return `${s.title}`.replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').slice(0, 80) || 'session';
}
function speakerName(m) {
  if (m.role === 'user') return 'Moderator (human)';
  if (m.speaker === 'moderator') return 'Moderator Assistant';
  return prompts.AGENTS[m.speaker] ? prompts.AGENTS[m.speaker].label : m.speaker;
}
function speakerColour(m) { return COLOURS[m.role === 'user' ? 'user' : m.speaker] || COLOURS.moderator; }
function modeLabel(mode) {
  return { opening: 'Round 1', round2: 'Round 2', round3: 'Round 3', crosstalk: 'Cross-talk', reply: 'Reply', custom: 'Custom round', decision: 'Decision output' }[mode] || mode || '';
}
function sourceMap(s) { const m = new Map(); for (const src of s.sources) m.set(src.n, src); return m; }

// ============================ DOCX ============================
function docxRuns(runs, base = {}) {
  const { TextRun, ExternalHyperlink } = docx;
  return runs.map((r) => {
    if (r.badge) return new TextRun({ text: r.text, bold: true, color: COLOURS[r.badge], size: base.size ? base.size - 2 : 18, font: FONT });
    if (r.cite) return new TextRun({ text: r.text, color: COLOURS.link, superScript: true, font: FONT });
    if (r.link) return new ExternalHyperlink({ children: [new TextRun({ text: r.text, style: 'Hyperlink', font: FONT })], link: r.link });
    return new TextRun({ text: r.text, bold: r.bold || base.bold, italics: r.italic, font: r.code ? 'Consolas' : FONT, size: base.size, color: base.color });
  });
}

function docxBlocks(md) {
  const { Paragraph, HeadingLevel, Table, TableRow, TableCell, WidthType, TextRun, ShadingType } = docx;
  const out = [];
  const H = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
  for (const b of parseBlocks(md)) {
    if (b.type === 'heading') out.push(new Paragraph({ heading: H[Math.min(b.level, 5) - 1], children: docxRuns(b.runs), spacing: { before: 200, after: 80 } }));
    else if (b.type === 'para') out.push(new Paragraph({ children: docxRuns(b.runs), spacing: { after: 100 } }));
    else if (b.type === 'bullet') out.push(new Paragraph({ children: docxRuns(b.runs), bullet: { level: b.level }, spacing: { after: 40 } }));
    else if (b.type === 'disagreement') out.push(new Paragraph({ children: docxRuns(b.runs, { bold: true, color: '9A3412' }), shading: { type: ShadingType.CLEAR, fill: 'FFF7ED' }, spacing: { before: 120, after: 60 } }));
    else if (b.type === 'code') out.push(new Paragraph({ children: [new TextRun({ text: b.text, font: 'Consolas', size: 18 })], shading: { type: ShadingType.CLEAR, fill: 'F1F5F9' } }));
    else if (b.type === 'table' && b.rows.length) {
      const cols = Math.max(...b.rows.map((r) => r.length));
      out.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: b.rows.map((row, i) => new TableRow({
          tableHeader: i === 0,
          children: Array.from({ length: cols }, (_, c) => new TableCell({
            children: [new Paragraph({ children: docxRuns(row[c] || [{ text: '' }], { bold: i === 0, size: 18 }) })],
            shading: i === 0 ? { type: ShadingType.CLEAR, fill: 'E2E8F0' } : undefined,
          })),
        })),
      }));
      out.push(new Paragraph({ text: '' }));
    }
  }
  return out;
}

async function toDocx(s) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, PageBreak, AlignmentType, ExternalHyperlink } = docx;
  const date = new Date().toISOString().slice(0, 10);
  const smap = sourceMap(s);
  const children = [];

  // Title page
  children.push(
    new Paragraph({ spacing: { before: 3000 } }),
    new Paragraph({ children: [new TextRun({ text: 'Anatop Territory Evaluation', font: FONT, size: 28, color: COLOURS.muted })], alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new TextRun({ text: s.inputs.product || 'Product: INPUT MISSING', font: FONT, size: 48, bold: true })], alignment: AlignmentType.CENTER, spacing: { before: 200 } }),
    new Paragraph({ children: [new TextRun({ text: s.inputs.country || 'Country: INPUT MISSING', font: FONT, size: 36 })], alignment: AlignmentType.CENTER, spacing: { before: 100 } }),
    new Paragraph({ children: [new TextRun({ text: `Session record · exported ${date}`, font: FONT, size: 22, color: COLOURS.muted })], alignment: AlignmentType.CENTER, spacing: { before: 400 } }),
    new Paragraph({ children: [new TextRun({ text: `${s.messages.length} messages · ${s.sources.length} sources · ${s.disagreements.length} disagreements logged`, font: FONT, size: 20, color: COLOURS.muted })], alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new PageBreak()] }),
  );

  // Inputs
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Inputs', font: FONT })] }));
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: prompts.INPUT_FIELDS.map((f) => new TableRow({ children: [
      new TableCell({ width: { size: 30, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: f.label, bold: true, font: FONT, size: 18 })] })] }),
      new TableCell({ width: { size: 70, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: (s.inputs[f.key] || '').trim() || 'INPUT MISSING', font: FONT, size: 18, color: s.inputs[f.key] ? undefined : COLOURS.unknown, italics: !s.inputs[f.key] })] })] }),
    ] })),
  }));
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // Transcript
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Transcript', font: FONT })] }));
  for (const m of s.messages) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2, spacing: { before: 300 },
      children: [new TextRun({ text: `${m.seq}. ${speakerName(m)}`, font: FONT, color: speakerColour(m) }),
        new TextRun({ text: `   ${modeLabel(m.mode)} · ${m.created_at} UTC`, font: FONT, size: 18, color: COLOURS.muted, bold: false })],
    }));
    if (m.error) children.push(new Paragraph({ children: [new TextRun({ text: `Turn failed: ${m.error}`, italics: true, color: '991B1B', font: FONT })] }));
    else children.push(...docxBlocks(m.text || ''));
  }

  // Disagreements
  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Disagreement log', font: FONT })] }));
  if (!s.disagreements.length) children.push(new Paragraph({ children: [new TextRun({ text: 'No disagreements were logged.', font: FONT, italics: true })] }));
  for (const d of s.disagreements) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: `#${d.n} ${d.topic}  —  ${d.status.toUpperCase()}`, font: FONT, color: d.status === 'resolved' ? COLOURS.verified : COLOURS.estimate })] }));
    children.push(...docxBlocks(d.body));
  }

  // Decision
  if (s.decision_text) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Decision output', font: FONT })] }));
    children.push(...docxBlocks(s.decision_text));
  }

  // Sources
  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Sources', font: FONT })] }));
  for (const src of s.sources) {
    const by = src.cited_by.map((c) => prompts.AGENTS[c.speaker] ? prompts.AGENTS[c.speaker].label : c.speaker).filter((v, i, a) => a.indexOf(v) === i).join(', ');
    children.push(new Paragraph({
      spacing: { after: 80 },
      children: [
        new TextRun({ text: `[${src.n}] `, bold: true, font: FONT, size: 18 }),
        new TextRun({ text: `${src.title || src.url}  `, font: FONT, size: 18 }),
        new ExternalHyperlink({ children: [new TextRun({ text: src.url, style: 'Hyperlink', font: FONT, size: 16 })], link: src.url }),
        new TextRun({ text: `  ·  ${src.kind === 'cited' ? 'cited' : 'search result'} · first ${src.first_cited_at} UTC · ${by}`, font: FONT, size: 16, color: COLOURS.muted }),
      ],
    }));
  }
  void smap;

  const doc = new Document({
    creator: 'Anatop Territory Evaluation',
    title: s.title,
    styles: {
      default: { document: { run: { font: FONT, size: 20 } } },
      paragraphStyles: [1, 2, 3, 4, 5].map((lvl) => ({
        id: `Heading${lvl}`, name: `Heading ${lvl}`, basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: FONT, bold: true, size: [36, 28, 24, 22, 20][lvl - 1], color: '0F172A' },
        paragraph: { spacing: { before: 240, after: 120 } },
      })),
    },
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}

// ============================ PDF ============================
pdfmake.setFonts({
  [FONT]: {
    normal: path.join(FONT_DIR, 'Montserrat-Regular.ttf'),
    bold: path.join(FONT_DIR, 'Montserrat-Bold.ttf'),
    italics: path.join(FONT_DIR, 'Montserrat-Italic.ttf'),
    bolditalics: path.join(FONT_DIR, 'Montserrat-BoldItalic.ttf'),
  },
});
pdfmake.setLocalAccessPolicy((p) => path.resolve(p).startsWith(path.resolve(FONT_DIR)));
pdfmake.setUrlAccessPolicy(() => false); // exports never fetch anything external

function pdfRuns(runs, base = {}) {
  return runs.map((r) => {
    if (r.badge) return { text: r.text, bold: true, color: '#' + COLOURS[r.badge], fontSize: (base.fontSize || 9.5) - 1.5 };
    if (r.cite) return { text: r.text, color: '#' + COLOURS.link, fontSize: 7, sup: true };
    if (r.link) return { text: r.text, link: r.link, color: '#' + COLOURS.link, decoration: 'underline' };
    return { text: r.text, bold: r.bold || base.bold, italics: r.italic, color: base.color, fontSize: base.fontSize };
  });
}

function pdfBlocks(md) {
  const out = [];
  let list = null;
  const flushList = () => { if (list) { out.push(list.ordered ? { ol: list.items, margin: [0, 0, 0, 6] } : { ul: list.items, margin: [0, 0, 0, 6] }); list = null; } };
  for (const b of parseBlocks(md)) {
    if (b.type !== 'bullet') flushList();
    if (b.type === 'heading') out.push({ text: pdfRuns(b.runs), style: `h${Math.min(b.level, 4)}` });
    else if (b.type === 'para') out.push({ text: pdfRuns(b.runs), margin: [0, 0, 0, 6] });
    else if (b.type === 'bullet') { if (!list || list.ordered !== b.ordered) { flushList(); list = { ordered: b.ordered, items: [] }; } list.items.push({ text: pdfRuns(b.runs) }); }
    else if (b.type === 'disagreement') out.push({ text: pdfRuns(b.runs, { bold: true, color: '#9A3412' }), fillColor: '#FFF7ED', margin: [0, 4, 0, 4] });
    else if (b.type === 'code') out.push({ text: b.text, fontSize: 8, fillColor: '#F1F5F9', margin: [0, 0, 0, 6] });
    else if (b.type === 'table' && b.rows.length) {
      const cols = Math.max(...b.rows.map((r) => r.length));
      out.push({
        table: { headerRows: 1, widths: Array(cols).fill('*'), body: b.rows.map((row, i) => Array.from({ length: cols }, (_, c) => ({ text: pdfRuns(row[c] || [{ text: '' }], { bold: i === 0, fontSize: 8 }), fillColor: i === 0 ? '#E2E8F0' : undefined }))) },
        layout: 'lightHorizontalLines', margin: [0, 0, 0, 8], fontSize: 8,
      });
    }
  }
  flushList();
  return out;
}

async function toPdf(s) {
  const date = new Date().toISOString().slice(0, 10);
  const content = [];
  content.push(
    { text: 'Anatop Territory Evaluation', color: '#' + COLOURS.muted, fontSize: 14, alignment: 'center', margin: [0, 200, 0, 8] },
    { text: s.inputs.product || 'Product: INPUT MISSING', fontSize: 24, bold: true, alignment: 'center' },
    { text: s.inputs.country || 'Country: INPUT MISSING', fontSize: 18, alignment: 'center', margin: [0, 6, 0, 0] },
    { text: `Session record · exported ${date}`, fontSize: 11, color: '#' + COLOURS.muted, alignment: 'center', margin: [0, 20, 0, 0] },
    { text: `${s.messages.length} messages · ${s.sources.length} sources · ${s.disagreements.length} disagreements logged`, fontSize: 10, color: '#' + COLOURS.muted, alignment: 'center', pageBreak: 'after' },
  );
  content.push({ text: 'Inputs', style: 'h1' });
  content.push({
    table: { widths: ['30%', '70%'], body: prompts.INPUT_FIELDS.map((f) => [{ text: f.label, bold: true, fontSize: 8.5 }, { text: (s.inputs[f.key] || '').trim() || 'INPUT MISSING', fontSize: 8.5, italics: !s.inputs[f.key], color: s.inputs[f.key] ? undefined : '#' + COLOURS.unknown }]) },
    layout: 'lightHorizontalLines', pageBreak: 'after',
  });
  content.push({ text: 'Transcript', style: 'h1' });
  for (const m of s.messages) {
    content.push({ text: [{ text: `${m.seq}. ${speakerName(m)}`, color: '#' + speakerColour(m) }, { text: `   ${modeLabel(m.mode)} · ${m.created_at} UTC`, fontSize: 8, color: '#' + COLOURS.muted, bold: false }], style: 'h2', margin: [0, 14, 0, 6] });
    if (m.error) content.push({ text: `Turn failed: ${m.error}`, italics: true, color: '#991B1B' });
    else content.push(...pdfBlocks(m.text || ''));
  }
  content.push({ text: 'Disagreement log', style: 'h1', pageBreak: 'before' });
  if (!s.disagreements.length) content.push({ text: 'No disagreements were logged.', italics: true });
  for (const d of s.disagreements) {
    content.push({ text: `#${d.n} ${d.topic}  —  ${d.status.toUpperCase()}`, style: 'h3', color: '#' + (d.status === 'resolved' ? COLOURS.verified : COLOURS.estimate) });
    content.push(...pdfBlocks(d.body));
  }
  if (s.decision_text) {
    content.push({ text: 'Decision output', style: 'h1', pageBreak: 'before' });
    content.push(...pdfBlocks(s.decision_text));
  }
  content.push({ text: 'Sources', style: 'h1', pageBreak: 'before' });
  for (const src of s.sources) {
    const by = src.cited_by.map((c) => prompts.AGENTS[c.speaker] ? prompts.AGENTS[c.speaker].label : c.speaker).filter((v, i, a) => a.indexOf(v) === i).join(', ');
    content.push({
      text: [{ text: `[${src.n}] `, bold: true }, { text: `${src.title || src.url}\n` }, { text: src.url, link: src.url, color: '#' + COLOURS.link, fontSize: 7.5 },
        { text: `\n${src.kind === 'cited' ? 'cited' : 'search result'} · first ${src.first_cited_at} UTC · ${by}`, fontSize: 7.5, color: '#' + COLOURS.muted }],
      fontSize: 8.5, margin: [0, 0, 0, 6],
    });
  }

  const docDefinition = {
    info: { title: s.title, author: 'Anatop Territory Evaluation' },
    pageSize: 'A4', pageMargins: [50, 50, 50, 50],
    defaultStyle: { font: FONT, fontSize: 9.5, lineHeight: 1.25 },
    styles: {
      h1: { fontSize: 18, bold: true, margin: [0, 0, 0, 10] },
      h2: { fontSize: 13, bold: true, margin: [0, 10, 0, 5] },
      h3: { fontSize: 11, bold: true, margin: [0, 8, 0, 4] },
      h4: { fontSize: 10, bold: true, margin: [0, 6, 0, 3] },
    },
    footer: (page, pages) => ({ text: `${s.title}  ·  ${page} / ${pages}`, alignment: 'center', fontSize: 7.5, color: '#' + COLOURS.muted, margin: [0, 15, 0, 0] }),
    content,
  };
  const doc = pdfmake.createPdf(docDefinition);
  return doc.getBuffer();
}

module.exports = { toDocx, toPdf, fileName };
