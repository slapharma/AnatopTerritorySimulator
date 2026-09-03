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
