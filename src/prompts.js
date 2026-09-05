'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./db');

const PROMPT_DIR = path.join(__dirname, '..', 'prompts');
const AGENTS_DIR = path.join(PROMPT_DIR, 'agents');

// Roster manifest: prompts/agents/index.json. Adding an agent (new folder +
// one manifest entry) needs no change here — AGENTS/AGENT_ORDER are derived
// from it at startup. The moderator stays file-based (prompts/moderator.md)
// and off this manifest, per the manifest's own "moderator" key.
const MANIFEST = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, 'index.json'), 'utf8'));

const AGENTS = {};
for (const a of MANIFEST.agents) AGENTS[a.key] = { label: a.label, dir: a.key, ...a };
AGENTS.moderator = { label: MANIFEST.moderator.label, file: 'moderator.md', ...MANIFEST.moderator };
const AGENT_ORDER = MANIFEST.agents.filter((a) => a.enabled).sort((x, y) => x.order - y.order).map((a) => a.key);

const COUNTRY_OPTIONS = [
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Argentina', 'Armenia', 'Australia', 'Austria',
  'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados', 'Belarus', 'Belgium', 'Belize', 'Benin',
  'Bhutan', 'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria', 'Burkina Faso',
  'Burundi', 'Cambodia', 'Cameroon', 'Canada', 'Cape Verde', 'Central African Republic', 'Chad', 'Chile',
  'China', 'Colombia', 'Comoros', 'Congo (DRC)', 'Congo (Republic)', 'Costa Rica', "Cote d'Ivoire", 'Croatia',
  'Cuba', 'Cyprus', 'Czechia', 'Denmark', 'Djibouti', 'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador',
  'Equatorial Guinea', 'Eritrea', 'Estonia', 'Eswatini', 'Ethiopia', 'Fiji', 'Finland', 'France', 'Gabon',
  'Gambia', 'Georgia', 'Germany', 'Ghana', 'Greece', 'Guatemala', 'Guinea', 'Guinea-Bissau', 'Guyana', 'Haiti',
  'Honduras', 'Hong Kong', 'Hungary', 'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel',
  'Italy', 'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kosovo', 'Kuwait', 'Kyrgyzstan', 'Laos',
  'Latvia', 'Lebanon', 'Lesotho', 'Liberia', 'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Macau',
  'Madagascar', 'Malawi', 'Malaysia', 'Maldives', 'Mali', 'Malta', 'Mauritania', 'Mauritius', 'Mexico',
  'Moldova', 'Monaco', 'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia', 'Nepal',
  'Netherlands', 'New Zealand', 'Nicaragua', 'Niger', 'Nigeria', 'North Macedonia', 'Norway', 'Oman',
  'Pakistan', 'Panama', 'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal', 'Qatar',
  'Romania', 'Russia', 'Rwanda', 'Saudi Arabia', 'Senegal', 'Serbia', 'Sierra Leone', 'Singapore', 'Slovakia',
  'Slovenia', 'Somalia', 'South Africa', 'South Korea', 'South Sudan', 'Spain', 'Sri Lanka', 'Sudan',
  'Suriname', 'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan', 'Tanzania', 'Thailand', 'Togo',
  'Trinidad and Tobago', 'Tunisia', 'Turkey', 'Turkmenistan', 'Uganda', 'Ukraine', 'United Arab Emirates',
  'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan', 'Venezuela', 'Vietnam', 'Yemen', 'Zambia',
  'Zimbabwe',
];

const BUDGET_OPTIONS = ['Under $1M', '$1M–$5M', '$5M–$10M', '$10M–$25M', '$25M–$50M', 'Over $50M', 'Not yet defined'];

const DEADLINE_OPTIONS = ['Within 3 months', '3–6 months', '6–12 months', '12–18 months', '18–24 months', 'No fixed deadline'];

const PARTNER_STATUS_OPTIONS = [
  'No partner yet — going direct', 'Identifying candidate partners', 'In discussions with a partner',
  'Partner selected, agreement pending', 'Partner agreement signed',
];

// Common global launch partners/competitors to exclude with one click, per the
// EXCLUSIONS field below. Free text still covers anything not on this list.
const COMPANY_OPTIONS = [
  'Pfizer', 'Novartis', 'Roche', 'Merck & Co', 'AbbVie', 'Johnson & Johnson', 'Sanofi', 'GSK', 'AstraZeneca',
  'Bristol Myers Squibb', 'Eli Lilly', 'Bayer', 'Takeda', 'Amgen', 'Gilead Sciences', 'Boehringer Ingelheim',
  'Novo Nordisk', 'Teva', 'Viatris', 'Sun Pharma',
];

// Autocomplete suggestions only (not a closed list) — INDICATION stays free text
// since the real value space is far too large to enumerate.
const INDICATION_SUGGESTIONS = [
  'Chronic anal fissure', 'Hypertension', 'Type 2 diabetes', 'Major depressive disorder', 'Rheumatoid arthritis',
  'Chronic pain', 'Migraine prophylaxis', 'Asthma', 'COPD', 'Psoriasis', 'Atopic dermatitis',
  'Gastroesophageal reflux disease', 'Insomnia', 'Generalized anxiety disorder', 'Osteoarthritis',
  'Chronic kidney disease', 'Heart failure', 'Overactive bladder', 'Erectile dysfunction', 'Acne vulgaris',
];

// Every field in Section 0 of the spec, in order. `key` is what the form posts.
// REGULATOR and REIMBURSEMENT_BODIES are deliberately not asked here: they are
// determined by COUNTRY, and the agents identify them themselves as their first
// research step (see prompts/regulatory.md, prompts/commercial.md).
const INPUT_FIELDS = [
  { key: 'product',              label: 'PRODUCT', required: true },
  { key: 'indication',           label: 'INDICATION', suggestions: INDICATION_SUGGESTIONS },
  { key: 'country',              label: 'COUNTRY', options: COUNTRY_OPTIONS, required: true },
  { key: 'reference_approvals',  label: 'REFERENCE APPROVALS', multiline: true,
    hint: 'Each country, approval date, pathway used, and whether a CPP is available' },
  { key: 'dossier',              label: 'DOSSIER ON HAND', multiline: true,
    hint: 'CTD modules available; pivotal trials: n, population, comparator, primary endpoint, result; stability data and shelf life; QP release site' },
  { key: 'manufacturing',        label: 'MANUFACTURING', multiline: true,
    hint: 'Site name, country, GMP certificates held (EU GMP / PIC/S), date of last inspection' },
  { key: 'commercial_targets',   label: 'COMMERCIAL TARGETS', multiline: true,
    hint: 'Target ex-factory or net price range; year-3 and year-5 volume ambition; minimum acceptable margin; preferred deal structure' },
  { key: 'partner_status',       label: 'PARTNER STATUS', type: 'select-other', options: PARTNER_STATUS_OPTIONS,
    hint: 'Choose Other to name a specific partner or add detail' },
  { key: 'exclusions',           label: 'EXCLUSIONS', type: 'multiselect', options: COMPANY_OPTIONS,
    hint: 'Companies that must not be proposed as partners — tick any that apply, add others below' },
  { key: 'budget_ceiling',       label: 'BUDGET CEILING', options: BUDGET_OPTIONS },
  { key: 'decision_deadline',    label: 'DECISION DEADLINE', options: DEADLINE_OPTIONS },
  { key: 'competitor_file',      label: 'COMPETITOR FILE', multiline: true,
    hint: 'Paste the existing competitor landscape if available' },
];

const BASE_VALUES = {
  product: 'Anatop — diltiazem hydrochloride 2% topical cream, 30 g tube',
  indication: 'Chronic anal fissure (adults)',
  country: 'South Korea',
  partner_status: 'Kwangdong Pharmaceutical — assessed; status to be confirmed',
  exclusions: 'Any company marketing a competing diltiazem or nifedipine fissure product',
};

function readPrompt(file) {
  return fs.readFileSync(path.join(PROMPT_DIR, file), 'utf8');
}
function readAgentFile(agentKey, file) {
  return fs.readFileSync(path.join(AGENTS_DIR, agentKey, file), 'utf8');
}
function rounds() {
  return JSON.parse(readPrompt('rounds.json'));
}

const STANCE = JSON.parse(readPrompt('stance.json'));
function stanceText(level) {
  const key = STANCE[String(level)] ? String(level) : String(STANCE.default);
  return STANCE[key].text;
}

// The cv.md files carry a "Verification status" note for human maintainers
// (when it was checked, by whom, what's still unverified) — useful in the
// repo, not something the persona should read as part of its own biography.
function stripVerificationNote(cv) {
  return cv.replace(/## Verification status[\s\S]*?(?=\n## )/, '').trim();
}

function fill(template, inputs) {
  const v = (k) => (inputs[k] && String(inputs[k]).trim()) || 'INPUT MISSING';
  return template
    .replace(/\{\{PRODUCT\}\}/g, v('product'))
    .replace(/\{\{INDICATION\}\}/g, v('indication'))
    .replace(/\{\{COUNTRY\}\}/g, v('country'));
}

function inputsBlock(inputs) {
  return INPUT_FIELDS.map((f) => {
    const val = inputs[f.key] && String(inputs[f.key]).trim();
    return `${f.label}: ${val || 'INPUT MISSING'}`;
  }).join('\n');
}

// Regulatory/Clinical/Commercial personas are file-backed
// (prompts/agents/<key>/{persona,questions,cv}.md — see prompts/agents/index.json)
// so an edit there changes behaviour on the next turn with no deploy and is
// reviewable in git. The DB row is an overlay only: the moderator-set
// challenge level (stance_default), free-text knowledge, and tool flags — it
// no longer supplies the persona text itself. The moderator's persona is not
// on the Agents page and stays entirely file-based.
async function personaFor(agentKey) {
  if (agentKey === 'moderator') return readPrompt(AGENTS.moderator.file);
  const row = await db.getAgent(agentKey);
  if (!row) throw new Error(`Agent ${agentKey} has no DB row — run the agents migration/seed`);
  const persona = readAgentFile(agentKey, 'persona.md').replace('{{STANCE_TEXT}}', stanceText(row.stance_default));
  const cv = stripVerificationNote(readAgentFile(agentKey, 'cv.md'));
  const questions = readAgentFile(agentKey, 'questions.md');
  const parts = [
    persona,
    '## YOUR BACKGROUND (for your own reference — speak from it, do not paste it verbatim)',
    cv,
    questions,
  ];
  if (row.knowledge && row.knowledge.trim()) parts.push(`Additional knowledge:\n${row.knowledge.trim()}`);
  return parts.filter(Boolean).join('\n\n');
}

// Raw, unfilled file text for the Agents page preview (no DB overlay, no
// stance substitution) — lets an admin see exactly what's checked into git.
function personaFilesRaw(agentKey) {
  if (agentKey === 'moderator') return readPrompt(AGENTS.moderator.file);
  return [
    readAgentFile(agentKey, 'persona.md'),
    readAgentFile(agentKey, 'questions.md'),
    stripVerificationNote(readAgentFile(agentKey, 'cv.md')),
  ].join('\n\n');
}

// Curated Drive knowledgebase (Admin > Knowledgebase page), titles + notes only.
// Links point into the company's private Drive — the agent's web tool cannot
// open them, so they're named as internal references to cite, not fetch.
async function knowledgeBlock() {
  const items = await db.listKnowledgeItems();
  if (!items.length) return '';
  const byCategory = new Map();
  for (const it of items) {
    if (!byCategory.has(it.category)) byCategory.set(it.category, []);
    byCategory.get(it.category).push(it);
  }
  const lines = [];
  for (const [category, rows] of byCategory) {
    lines.push(`### ${category}`);
    for (const r of rows) {
      const flag = r.sensitive ? ' [SENSITIVE — commercial terms; do not quote figures]' : '';
      lines.push(`- ${r.title}${r.note ? ` — ${r.note}` : ''}${flag}`);
    }
  }
  return [
    '## INTERNAL KNOWLEDGEBASE (curated company Drive index — titles/notes only)',
    'These are real internal documents the company holds. You cannot open their Drive links with your web tool — cite them by title as internal references ("per the company\'s [title]") when relevant, do not invent their content, and never present a title as something you have read in full.',
    '',
    lines.join('\n'),
  ].join('\n');
}

async function systemPrompt(agentKey, inputs) {
  const agent = AGENTS[agentKey];
  if (!agent) throw new Error(`Unknown agent ${agentKey}`);
  const persona = fill(await personaFor(agentKey), inputs);
  const rules = fill(readPrompt('evidence-rules.md'), inputs);
  const today = new Date().toISOString().slice(0, 10);
  const others = AGENT_ORDER.filter((k) => k !== agentKey).map((k) => AGENTS[k].label).join(', ');
  const knowledge = agentKey === 'moderator' ? '' : await knowledgeBlock();
  return [
    persona,
    '',
    '## INPUTS (from the moderator. Treat INPUT MISSING literally; never invent it)',
    '```',
    inputsBlock(inputs),
    '```',
    '',
    rules,
    knowledge ? `\n${knowledge}` : '',
    '',
    `Today's date is ${today}. The other agents in the room are: ${others}. The human moderator is addressed as "Moderator".`,
  ].join('\n');
}

// Which tools an agent may use this turn — DB-backed (Agents page), defaults
// to both enabled for the moderator (not on that page, no restriction).
async function agentAbilities(agentKey) {
  if (agentKey === 'moderator') return { can_web_search: true, can_open_url: true };
  const row = await db.getAgent(agentKey);
  return row ? { can_web_search: row.can_web_search, can_open_url: row.can_open_url } : { can_web_search: true, can_open_url: true };
}

function speakerLabel(msg) {
  if (msg.role === 'user') return 'MODERATOR (human)';
  if (msg.speaker === 'moderator') return 'MODERATOR ASSISTANT (decision output)';
  return AGENTS[msg.speaker] ? AGENTS[msg.speaker].label.toUpperCase() : String(msg.speaker).toUpperCase();
}

// Characters, not tokens (no tokenizer here) — a conservative ~4 chars/token
// budget so a long session doesn't silently overflow a free model's context
// window mid-turn. Older messages drop first; the full record is always in
// the export, so nothing is actually lost, just not re-sent every turn.
const MAX_TRANSCRIPT_CHARS = 60000;

function transcriptText(messages) {
  const usable = messages.filter((m) => !m.error && m.text);
  if (!usable.length) return '(no messages yet. This is the first turn)';
  const blocks = usable.map((m) => {
    const to = m.role === 'user' && m.addressed_to && m.addressed_to !== 'all' ? ` (to ${AGENTS[m.addressed_to] ? AGENTS[m.addressed_to].label : m.addressed_to})` : '';
    return `--- [${m.seq}] ${speakerLabel(m)}${to} · ${m.created_at} ---\n${m.text}`;
  });
  let total = blocks.reduce((n, b) => n + b.length + 2, 0);
  let dropped = 0;
  while (total > MAX_TRANSCRIPT_CHARS && blocks.length > 1) {
    total -= blocks.shift().length + 2;
    dropped++;
  }
  if (dropped) blocks.unshift(`--- ${dropped} earlier message(s) omitted here to stay within the model's context budget; the full transcript is in the session record and export. ---`);
  return blocks.join('\n\n');
}

const COMPACT_SUFFIX = "\n\nKeep this response compact: under 350 words, lead with your conclusion, use tight bullet points, and do not restate context or repeat earlier messages. Full depth and nuance are for if the moderator clicks \"Dive Deeper\" on this response — until then, favour brevity.";

// The human moderator's RESOLVED/UNRESOLVED toggles (War Room > Disagreements)
// otherwise never reach the model — an agent would keep re-litigating a topic
// the moderator already marked settled, or "resolve" one still flagged open.
function disagreementLogText(disagreements) {
  if (!disagreements || !disagreements.length) return '';
  const lines = disagreements.map((d) => `- #${d.n} [${d.status.toUpperCase()}] ${d.topic}`);
  return [
    '## DISAGREEMENT LOG (status as set by the human moderator — do not contradict without new evidence)',
    lines.join('\n'),
  ].join('\n');
}

function turnUserMessage({ agentKey, mode, instruction, messages, disagreements }) {
  const r = rounds();
  let roundText = r[mode] || r.crosstalk;
  if (mode === 'custom') roundText = `${r.custom}\n\nCUSTOM INSTRUCTION:\n${instruction || '(none given)'}`;
  if (mode === 'decision') roundText = 'Write the DECISION OUTPUT now from the transcript above.';
  if (mode === 'dive_deeper') roundText = `${r.dive_deeper}\n\n${instruction || ''}`;
  else if (mode === 'meeting_minutes') roundText = `${r.meeting_minutes}\n\nMEETING: ${instruction || mode}`;
  else if (mode !== 'decision') roundText += COMPACT_SUFFIX;
  const who = agentKey === 'moderator' ? 'the MODERATOR ASSISTANT' : `the ${AGENTS[agentKey].label.toUpperCase()}`;
  const disText = disagreementLogText(disagreements);
  // Round 1 (opening) is answered independently by design — the round text
  // itself says not to reference other agents. Showing the real transcript
  // here would leak later rounds' content into it if opening is ever re-run
  // or resumed after other rounds already happened, so it never sees one.
  const parts = mode === 'opening'
    ? ['## TRANSCRIPT SO FAR', '(Round 1: Baselines. Answer independently — do not reference other agents or any other message, even if some exist.)']
    : ['## TRANSCRIPT SO FAR', transcriptText(messages)];
  if (disText) parts.push('', disText);
  parts.push('', `## YOUR TURN. You are ${who}.`, roundText);
  return parts.join('\n');
}

module.exports = {
  AGENTS, AGENT_ORDER, INPUT_FIELDS, BASE_VALUES, systemPrompt, agentAbilities,
  turnUserMessage, inputsBlock, speakerLabel, rounds, STANCE, personaFilesRaw,
};

