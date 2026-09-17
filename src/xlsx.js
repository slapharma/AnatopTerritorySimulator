'use strict';
// A minimal .xlsx writer: one worksheet, a bold header row, wrapped text.
// Built by hand on jszip rather than a spreadsheet library because every
// export here is a single plain table, and jszip is already installed for
// docx. Cells are inline strings, so there is no shared-string table to keep.
const JSZip = require('jszip');
const { parseBlocks, plain, tagSlides } = require('./markdown-blocks');

// Excel rejects the whole file over one control character, and caps a cell
// at 32,767 characters.
const MAX_CELL = 32767;
function cellText(v) {
  const s = String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s;
}
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 0 -> A, 25 -> Z, 26 -> AA.
function colName(i) {
  let n = i + 1;
  let out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

// Sheet names: at most 31 characters, none of : \ / ? * [ ], and no
// apostrophe at either end (Excel offers to repair a file that has one).
function sheetName(name) {
  return String(name || 'Sheet1').replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31)
    .replace(/^['\s]+|['\s]+$/g, '') || 'Sheet1';
}

/**
 * { sheet, columns: [{ header, width }], rows: [[value, ...], ...] } -> Buffer.
 */
async function toXlsx({ sheet, columns, rows }) {
  const cols = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 20}" customWidth="1"/>`).join('');
  const rowXml = (values, r, style) => `<row r="${r}">${values.map((v, c) => {
    const t = cellText(v);
    return `<c r="${colName(c)}${r}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(t)}</t></is></c>`;
  }).join('')}</row>`;
  const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<cols>${cols}</cols><sheetData>`
    + rowXml(columns.map((c) => c.header), 1, 1)
    + rows.map((values, i) => rowXml(values, i + 2, 2)).join('')
    + '</sheetData></worksheet>';

  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '</Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>');
  zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets><sheet name="${xml(sheetName(sheet))}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>');
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  // Style 0 default, 1 bold header, 2 wrapped top-aligned body.
  zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="3">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
    + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Markdown as structured rows: one row per heading, paragraph, bullet or code
// block, each carrying the heading it sits under; a Markdown table becomes one
// row per table row with its cells in columns of their own.
function markdownRows(md) {
  const blocks = tagSlides(parseBlocks(md));
  const rows = [];
  let section = '';
  let widest = 0;
  for (const b of blocks) {
    if (b.type === 'heading') { section = plain(b.runs).trim(); rows.push([section, 'Heading', section]); continue; }
    if (b.type === 'slides-label') { section = 'Summary slides'; rows.push([section, 'Heading', section]); continue; }
    if (b.type === 'slide-title') { section = `Slide ${b.n || ''} ${plain(b.runs)}`.replace(/\s+/g, ' ').trim(); rows.push([section, 'Heading', section]); continue; }
    if (b.type === 'table') {
      for (const r of b.rows) {
        const cells = r.map((c) => plain(c).trim());
        widest = Math.max(widest, cells.length);
        rows.push([section, 'Table row', ...cells]);
      }
      continue;
    }
    const kind = { para: 'Paragraph', bullet: 'Bullet', code: 'Code', disagreement: 'Disagreement' }[b.type] || b.type;
    const text = b.type === 'code' ? b.text : plain(b.runs).trim();
    if (text) rows.push([section, kind, text]);
  }
  const columns = [{ header: 'Section', width: 30 }, { header: 'Type', width: 12 }, { header: 'Text', width: 90 }];
  for (let i = 1; i < widest; i++) columns.push({ header: `Column ${i + 1}`, width: 30 });
  return { columns, rows };
}

module.exports = { toXlsx, markdownRows, sheetName, colName, cellText };
