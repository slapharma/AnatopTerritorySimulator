'use strict';
// Sends report emails via Resend's HTTPS API directly (no SDK dependency —
// works from Vercel with a plain fetch, same as OpenRouter in agents.js).
const RESEND_BASE = 'https://api.resend.com';

function firstParagraph(text) {
  const blocks = String(text || '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const bluf = blocks.find((b) => !/^#{1,6}\s/.test(b)) || blocks[0] || '';
  return bluf.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').slice(0, 1200);
}

const KIND_LABEL = { interim: 'Interim report', final: 'Final report' };
const DEPTH_LABEL = { brief: 'Brief', standard: 'Standard', full: 'Full' };

async function sendReportEmail({ session, report, to, attachments, note, sentBy }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { const e = new Error('RESEND_API_KEY is not set'); e.code = 'NO_API_KEY'; throw e; }
  const from = process.env.MAIL_FROM;
  if (!from) { const e = new Error('MAIL_FROM is not set'); e.code = 'NO_FROM'; throw e; }

  const product = session.inputs.product || 'Product: INPUT MISSING';
  const country = session.inputs.country || 'Country: INPUT MISSING';
  const subject = `${KIND_LABEL[report.kind] || report.kind} (${DEPTH_LABEL[report.depth] || report.depth}) — ${product} — ${country}`;
  const lines = [
    `${KIND_LABEL[report.kind] || report.kind}, ${DEPTH_LABEL[report.depth] || report.depth} depth.`,
    `${product} — ${country}.`,
    sentBy ? `Sent by ${sentBy}.` : null,
    note ? `\n${note}` : null,
    '',
    firstParagraph(report.text),
    '',
    'Full report attached.',
  ].filter((l) => l !== null);

  const body = {
    from, to, subject, text: lines.join('\n'),
    attachments: (attachments || []).map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })),
  };
  const res = await fetch(`${RESEND_BASE}/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Resend HTTP ${res.status}: ${json.message || JSON.stringify(json)}`);
    err.status = res.status;
    throw err;
  }
  return json; // { id }
}

module.exports = { sendReportEmail };
