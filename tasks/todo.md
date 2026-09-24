# Launch Working Group — work plan

Source docs:
- `Anatop_Launch_WorkingGroup_Prompt_v2_1.md` — agent spec (source of truth for agent behaviour)
- `ClaudeCode_Prompt_LaunchWorkingGroup_App.md` — app build brief

## Decisions (2026-09-03)

- Build here (Google Drive folder). Consequence: `node_modules` and the SQLite DB live in `%LOCALAPPDATA%\launch-working-group`; `src/server.js` points Node at them. Junctions are refused by the Drive filesystem and npm writes fail with EBADF, so this is the only workable layout.
- Round 2 / Round 3 buttons plus a free-form "Custom round…" override (instruction + choice of agents).
- PDF via `pdfmake` 0.3 with self-hosted Montserrat TTF.
- Model `claude-sonnet-5`, web search tool `web_search_20260209`, adaptive thinking.
- Inputs are filled per run in the form; "Load Korea example" and "Copy from last session" buttons pre-fill.

## Stages

### Stage 0 — Scaffold
- [x] `git init`, `.gitignore`, `package.json`, deps installed to local disk
- [x] `.env.example`, `src/config.js` (model, prices, limits)
- [x] Montserrat TTF (Regular / Italic / SemiBold / Bold / BoldItalic) in `fonts/`
- [x] Design system generated and adjusted: `design-system/MASTER.md`
- [x] `README.md`

### Stage A — Setup form + opening round
- [x] `prompts/` (persona files, evidence rules, moderator brief, `rounds.json`)
- [x] SQLite schema (sessions, messages, sources, disagreements)
- [x] Form with all 14 Section 0 fields; blanks → INPUT MISSING
- [x] SSE streaming turn endpoint; sequential Round 1 Regulatory → Clinical → Commercial
- [x] Tag badges green / amber / grey
- [x] Error surfaced with Retry (verified with no API key: error event + Retry button rendered)

### Stage B — Discussion + cross-talk
- [x] Composer with To: one agent / all; Ctrl+Enter
- [x] Cross-talk, Round 2, Round 3, Custom round buttons; "Stop after this turn"
- [x] "Questions for:" block highlighted
- [x] ⚠ DISAGREEMENT parsed into log with toggle (verified: click flips UNRESOLVED → RESOLVED, counter 1/1 → 0/1)

### Stage C — Save / reopen + sources + cost
- [x] Autosave every message; sidebar list; reopen
- [x] Sources captured from citations and search results, deduped, numbered; `[n]` links jump to panel
- [x] Cost meter (tokens × config prices, USD and GBP)

### Stage D — Decision output
- [x] Moderator prompt (10 sections); button; stored on session
- [x] Exercised live: Korea example, produced full 10-section DECISION OUTPUT message

### Stage E — Exports
- [x] DOCX (`docx`): Montserrat in every run, badge colours, hyperlinks, heading styles
- [x] PDF (`pdfmake`): Montserrat embedded, footer paging
- [x] Live 17-message session export: DOCX 200/`application/vnd...wordprocessingml.document`, real content (403k chars extracted); PDF 200/`application/pdf`, 108 pages, valid `%PDF`/`%%EOF`
- [ ] Visual check of the PDF in a desktop viewer (only structural/text checks run here)

### Stage F — Live run
- [x] `.env` created with working key/model (OpenRouter, `nvidia/nemotron-3-ultra-550b-a55b:free`, not Anthropic — decision changed since Stage 0 note above)
- [x] Ran Korea example Round 1, 2, 3 live: MFDS/HIRA/Korean-language searches fired, VERIFIED/ESTIMATE/UNKNOWN badges and citations rendered, 526 sources collected, 22 disagreements logged, cost meter updated
- [x] Decision output generated live
- [x] Both exports pulled from the live session and content-verified (see Stage E)

### Branding (2026-09-03, mid-session)
- [x] Renamed app from "Launch Working Group" to "Anatop Territory Evaluation" — page `<title>`, sidebar header, DOCX/PDF export titles, docx `creator`, pdf `info.title`
- [x] Added SLA Pharma logo above the sidebar title (`public/sla-logo.png`, pulled from slapharma.com) with spacing below it

## Review

Verified this session (each check was one that could fail):
- Server starts, serves fonts and `marked`; body font resolves to Montserrat, `document.fonts.check` true.
- Turn with no key → SSE `error` event, message row saved with error, UI shows error + Retry, toolbar re-enabled.
- Synthetic message: 1 VERIFIED / 1 ESTIMATE / 1 UNKNOWN badge, 1 citation link, 1 table, 1 disagreement block, 1 questions block, 2 sources listed, cost meter $0.050.
- Disagreement toggle round-trips through the API.
- DOCX and PDF endpoints return 200 with correct content types and attachment names.

Not verified: any live model turn, web search capture from real API responses, PDF appearance in a viewer.

## Agent Questions (2026-09-16)

Decisions (Clifton): answered-check is an AI pass by the Moderator Assistant after each
meeting; "discuss to resolution" loops asker and addressee(s) on the Autopilot engine;
a question not resolved within the set number of loops is marked escalated to the
moderator for offline review.

- [ ] `src/questions.js`: parse `Questions for <X>:` blocks into {addressees, n, text}
- [ ] `agent_questions` table in `sql/schema.sql` (+ RLS list); db list/add/update, tolerant of the table not existing yet
- [ ] Extract questions after every agent turn; send the list back in the turn's `done` event
- [ ] Routes: PATCH status, POST answer (moderator reply to the asker), POST scan (backfill), POST check (AI answered-check)
- [ ] Autopilot scope `question`: fixed order addressees then asker, asker ends `QUESTION STATUS: RESOLVED|OPEN`; resolved → resolved, loop cap/cost cap → escalated
- [ ] Intelligence tab "Agent Questions": filters, asker → addressee chips, status, asked-in / answered-in links, Answer, Discuss to resolution, mark/reopen/escalate
- [ ] Run the answered-check whenever a meeting completes
- [ ] Guide section; tests; review; hand over the schema command (the prod table must be created by hand)

## Question minutes, conversation names in Agent notes, Intelligence page (2026-09-16)

Decisions (Clifton): a minutes entry for every question action (moderator answer, discuss to
resolution with any outcome, mark answered, escalate, reopen, the automatic answered-check);
entries are a plain record built from data (no model call, no email, no Approve); the
Escalations tab lists escalated questions.

- [x] `src/questions.js`: pure `questionMinutes()` builds {label, text, anchor} for one action
- [x] `src/app.js`: write the entry from PATCH status, POST answer, POST check; PATCH accepts `discussion: {run_id, outcome, cycles}`; responses carry `meeting_minutes`
- [x] Client: settle a question discussion on every outcome (unchanged status still PATCHes with the run), update minutes from responses; question entries render without Approve
- [x] Agent notes: autopilot rows and groups named by conversation (Autopilot discussion / on disagreement #n: topic / Question discussion: asker to addressees)
- [x] Intelligence becomes a page inside the session view; its tabs are a sidebar nav under the Meeting Agenda with a Meeting transcript item; header Intelligence button toggles the page; any agent turn switches back to the transcript
- [x] Escalations tab (escalated questions, same card actions)
- [x] Guide text; tests; reviews

### Review

- Verified in the browser against an in-memory fake db (never the production DATABASE_URL): Escalations tab lists the escalated question and its count turns amber; reopen, mark answered, moderator answer and a discussion outcome each add a Minutes entry with no Approve button; "view in transcript" switches back; starting Converge from the Intelligence page returns to the transcript; Agent notes shows Question discussion / Disagreement debate #1 / Panel debate 1 instead of Autopilot.
- debugger: PATCH and answer routes read the old status after the update; fixed by capturing it first.
- code-reviewer: Decision/Favourites jump buttons, no tab access under 900px, stale status after a stopped discussion; all fixed and confirmed.
- security-auditor: one Low (repeat PATCH with a discussion can add unlimited minutes entries), not fixed.
- Not done: URL does not reflect the open Intelligence tab; Escape no longer leaves the page.

## UI updates and feature refactor (2026-09-17)

- [x] Restore CSS dropped by 569b150 (drawer, dialogs, usage modal, sources, disagreements, cost chip): Admin/Agents slide-over works again
- [x] Remove "Default model" from the sidebar foot
- [x] 100px space above New evaluation; blue "View all evaluations" button under it
- [x] Remove the sidebar Autopilot button; Autopilot becomes a "How it runs" option inside Custom meeting (agenda item now reaches autopilot turns)
- [x] Transcript agent headshots 36px -> 47px (+30%)
- [x] Agent Questions: "Ask agents to answer…" (custom turn per picked agent, then the answered-check)
- [x] "Mark answered" -> "Mark as Resolved" (sets resolved); "Escalate" -> "Escalate to Moderator"
- [x] "Check for answers now" / "Rescan transcript" moved into the qn-filters bar
- [x] Disagreements moved under Panel
- [x] Evidence > Knowledgebase tab (moved from Admin), add-source form at top
- [x] Dashboard: action tiles removed; hero fills the main column with no scroll
- [x] Session sidebar fits the window with no scroll (horizontal meeting stepper, tighter rows; the 100px gap shrinks first on shorter windows). Checked at 1000, 860 and 760px tall
- [x] Minutes: "Approve and continue" approves, then convenes the next meeting on the agenda

## Fact-checking and moderator-evidence fixes (2026-09-24 audit)

Source: `tasks/audit-2026-09-24-human-factcheck.md`.

Decisions (Clifton, 2026-09-24): default model Qwen 3.7 Flash; VERIFIED tags carry a verbatim quote; restore a Pivotal evidence input.

Batch 1: close the hallucination paths
- [x] Check the audit harness in as `scripts/simulate-session.js` (in-memory db, never reads
      DATABASE_URL); it is the before/after measurement for every item below
- [x] Default model moved to a model that calls its tools; update the MODEL_OPTIONS flags
- [x] A zero-search evidence turn is refused once, then flagged "no research this turn"
- [x] One opened-URL set per session; record both the requested and the final URL; normalise
      URLs before comparing
- [x] Sources: new `unverified` kind for URLs nobody searched or opened; UI and exports show it
- [x] Minutes: figures keep their tags; Open disagreements come from the database log
- [x] Evidence table built by the app from session data, passed to reports and rendered as-is
- [x] Report `max_tokens` raised for Brief and Standard so reasoning models can finish

Batch 2: VERIFIED means "the page says so"
- [x] Quote-anchored VERIFIED, checked server-side against the page text open_url returned
- [x] Personas: drop the "refer back to your own past reviews" and insider lines; experience
      may appear only as labelled professional judgement
- [x] INTERNAL tag for knowledgebase titles; resolve the pivotal-data input gap
- [x] "secondary" label required for blog, consultancy and law-firm sources

Batch 3: evidence in front of the moderator
- [x] Evidence strip per message, agent and session (searches, opens, tag counts)
- [x] Distinct downgraded badge; Sources separates opened, searched and unverified
- [x] Questions for the Moderator: count and filter, excluded from the auto-check, "(human)" parsed
- [x] Decision banner with stale flag; truncated turns warned (the meeting step still turns green: not changed)
- [x] Guide: what VERIFIED does and does not prove

Also done: disagreement regex tolerance, report transcript window, `moderator.md` split from the report
prompts, moderator turns no longer rewrite disagreement statuses. Not done (need a production schema
change): cascade delete of disagreements on regenerate; an agent restatement still overwrites the
moderator's resolved/unresolved toggle.

Verification for every batch: re-run the audit harness (Korea example, both models) and
compare searches, opens, unverified URLs, downgrades and unsupported-VERIFIED spot checks
against the 2026-09-24 baseline.


### Review (2026-09-24)

Measured with `scripts/simulate-session.js` (Korea example, in-memory db), before vs after:

| | Before, Nemo default | Before, Qwen | After, Qwen default |
|---|---|---|---|
| Evidence turns with no search | 6 of 6 | 0 | 0 |
| VERIFIED that passed the check | 0 (of 19 claimed) | 9 page-opened, 2 of 6 checked unsupported | 19, all quote-checked |
| Cited links nobody searched or opened | 17 | 2 | 0 |
| Standard Final report | written, "VERIFIED: 12" false | failed (token cap) | written, app-built register |
| Minutes | tags stripped, invented facts | tags stripped, invented date | tags kept, disagreements from log |
| Cost | $0.002 | $0.03 | $0.038 |

Nemo re-run on the fixed code (it stays selectable only for a session that already has it, and is
moved off at the next turn): 6 of 6 evidence turns still unresearched after the research nudge, now
flagged "No research this turn" in the UI, 4 claims shown UNVERIFIED, 2 links shown as unverified.

Residual limits: the quote proves the page says the words, not that the words support the whole
claim (seen: a quote about a planned fee rise attached to specific fee figures). The moderator can
now see the quote beside the claim; nothing checks the fit mechanically.
