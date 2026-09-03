'use strict';
const fs = require('fs');
const path = require('path');

const PROMPT_DIR = path.join(__dirname, '..', 'prompts');

const AGENTS = {
  regulatory: { label: 'Regulatory Agent', file: 'regulatory.md' },
  clinical:   { label: 'Clinical Agent',   file: 'clinical.md' },
  commercial: { label: 'Commercial Agent', file: 'commercial.md' },
  moderator:  { label: 'Moderator Assistant', file: 'moderator.md' },
};
const AGENT_ORDER = ['regulatory', 'clinical', 'commercial'];

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

// Every field in Section 0 of the spec, in order. `key` is what the form posts.
// REGULATOR and REIMBURSEMENT_BODIES are deliberately not asked here: they are
// determined by COUNTRY, and the agents identify them themselves as their first
// research step (see prompts/regulatory.md, prompts/commercial.md).
const INPUT_FIELDS = [
  { key: 'product',              label: 'PRODUCT' },
  { key: 'indication',           label: 'INDICATION' },
  { key: 'country',              label: 'COUNTRY', options: COUNTRY_OPTIONS },
  { key: 'reference_approvals',  label: 'REFERENCE APPROVALS', multiline: true,
    hint: 'Each country, approval date, pathway used, and whether a CPP is available' },
  { key: 'dossier',              label: 'DOSSIER ON HAND', multiline: true,
    hint: 'CTD modules available; pivotal trials: n, population, comparator, primary endpoint, result; stability data and shelf life; QP release site' },
  { key: 'manufacturing',        label: 'MANUFACTURING', multiline: true,
    hint: 'Site name, country, GMP certificates held (EU GMP / PIC/S), date of last inspection' },
  { key: 'commercial_targets',   label: 'COMMERCIAL TARGETS', multiline: true,
    hint: 'Target ex-factory or net price range; year-3 and year-5 volume ambition; minimum acceptable margin; preferred deal structure' },
  { key: 'partner_status',       label: 'PARTNER STATUS', multiline: true },
  { key: 'exclusions',           label: 'EXCLUSIONS', multiline: true,
    hint: 'Companies that must not be proposed as partners' },
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
function rounds() {
  return JSON.parse(readPrompt('rounds.json'));
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

function systemPrompt(agentKey, inputs) {
  const agent = AGENTS[agentKey];
  if (!agent) throw new Error(`Unknown agent ${agentKey}`);
  const persona = fill(readPrompt(agent.file), inputs);
  const rules = fill(readPrompt('evidence-rules.md'), inputs);
  const today = new Date().toISOString().slice(0, 10);
  const others = AGENT_ORDER.filter((k) => k !== agentKey).map((k) => AGENTS[k].label).join(', ');
  return [
    persona,
    '',
    '## INPUTS (from the moderator. Treat INPUT MISSING literally; never invent it)',
    '```',
    inputsBlock(inputs),
    '```',
    '',
    rules,
    '',
    `Today's date is ${today}. The other agents in the room are: ${others}. The human moderator is addressed as "Moderator".`,
  ].join('\n');
}

function speakerLabel(msg) {
  if (msg.role === 'user') return 'MODERATOR (human)';
  if (msg.speaker === 'moderator') return 'MODERATOR ASSISTANT (decision output)';
  return AGENTS[msg.speaker] ? AGENTS[msg.speaker].label.toUpperCase() : String(msg.speaker).toUpperCase();
}

function transcriptText(messages) {
  const usable = messages.filter((m) => !m.error && m.text);
  if (!usable.length) return '(no messages yet. This is the first turn)';
  return usable
    .map((m) => {
      const to = m.role === 'user' && m.addressed_to && m.addressed_to !== 'all' ? ` (to ${AGENTS[m.addressed_to] ? AGENTS[m.addressed_to].label : m.addressed_to})` : '';
      return `--- [${m.seq}] ${speakerLabel(m)}${to} · ${m.created_at} ---\n${m.text}`;
    })
    .join('\n\n');
}

function turnUserMessage({ agentKey, mode, instruction, messages }) {
  const r = rounds();
  let roundText = r[mode] || r.crosstalk;
  if (mode === 'custom') roundText = `${r.custom}\n\nCUSTOM INSTRUCTION:\n${instruction || '(none given)'}`;
  if (mode === 'decision') roundText = 'Write the DECISION OUTPUT now from the transcript above.';
  const who = agentKey === 'moderator' ? 'the MODERATOR ASSISTANT' : `the ${AGENTS[agentKey].label.toUpperCase()}`;
  return [
    '## TRANSCRIPT SO FAR',
    transcriptText(messages),
    '',
    `## YOUR TURN. You are ${who}.`,
    roundText,
  ].join('\n');
}

module.exports = { AGENTS, AGENT_ORDER, INPUT_FIELDS, BASE_VALUES, systemPrompt, turnUserMessage, inputsBlock, speakerLabel, rounds };
