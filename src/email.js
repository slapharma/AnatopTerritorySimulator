'use strict';
// Sends emails via Resend's HTTPS API directly (no SDK dependency — works from
// Vercel with a plain fetch, same as OpenRouter in agents.js). Two independent
// senders share this file: report emails (Interim/Final, on-demand, MAIL_FROM)
// and meeting-minutes emails (fire-and-forget after each round, RESEND_FROM).
const RESEND_BASE = 'https://api.resend.com';

// ---------- report emails ----------
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

// ---------- meeting-minutes emails ----------
const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function button(href, label) {
  return `<a href="${href}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;background:#0891B2;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:13px;font-family:Arial,sans-serif">${label}</a>`;
}

// Fire-and-forget: the caller catches/logs, never awaits this to block the response.
async function sendMeetingMinutesEmail(session, minutesRow, recipientEmail) {
  if (!process.env.RESEND_API_KEY) { console.log('[email] RESEND_API_KEY not set — skipping meeting minutes email'); return; }
  if (!recipientEmail) { console.log('[email] no recipient (no logged-in user email and no MODERATOR_EMAIL) — skipping'); return; }

  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';
  const viewUrl = `${BASE_URL}/?session=${session.id}`;
  const transcriptUrl = minutesRow.anchor_message_id ? `${BASE_URL}/?session=${session.id}#msg-${minutesRow.anchor_message_id}` : viewUrl;
  const approveUrl = `${BASE_URL}/api/meeting-minutes/${minutesRow.approve_token}/approve`;
  const bodyHtml = minutesRow.text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 10px;white-space:pre-wrap">${escapeHtml(p)}</p>`)
    .join('');

  const html = `
    <div style="font-family:Arial,sans-serif;color:#0F172A;max-width:640px;margin:0 auto">
      <h2 style="margin:0 0 4px">${escapeHtml(session.title || 'Anatop Territory Evaluation')}</h2>
      <p style="margin:0 0 18px;color:#64748B;font-size:13px">Meeting minutes — ${escapeHtml(minutesRow.label)}</p>
      <div style="border:1px solid #E2E8F0;border-radius:10px;padding:16px 18px;margin-bottom:18px;font-size:13.5px;line-height:1.55">${bodyHtml}</div>
      <div>${button(viewUrl, 'View online')}${button(transcriptUrl, 'Read full meeting transcript')}${button(approveUrl, 'Approve next meeting')}</div>
    </div>`;

  const r = await fetch(`${RESEND_BASE}/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: recipientEmail,
      subject: `Meeting minutes — ${session.title || 'session'} · ${minutesRow.label}`,
      html,
    }),
  });
  if (!r.ok) throw new Error(`Resend API ${r.status}: ${await r.text().catch(() => r.statusText)}`);
}

module.exports = { sendReportEmail, sendMeetingMinutesEmail, BASE_URL };
