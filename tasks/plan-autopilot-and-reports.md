# Plan: Autopilot round + Interim / Final reports

Status: PLAN ONLY (2026-09-05). Nothing below is built.

Source of truth for current behaviour: `src/app.js` (turn endpoint), `src/prompts.js` + `prompts/rounds.json` (round instructions), `public/app.js` (`runSequence`, `runRound1Parallel`, disagreement modal), `src/export.js` (DOCX/PDF), `prompts/moderator.md` (10-section decision output).

Two dependencies on other work:
- The per-agent "aggressive / passive" control is being renamed in another session. This plan calls it **STANCE** as a placeholder. Whatever name and storage that session lands on (expected: a column on `agents`, editable on the Agents page) is what Part A reads. Do not add a second stance field here.
- Email needs a verified sending domain in Resend (or equivalent). That is a user action outside the repo.

---

## Part A — Autopilot ("let the agents respond to each other")

### A1. What changes

Today the button `Let the agents respond to each other` runs one `crosstalk` cycle: three sequential turns, then stops. It stays as-is for a single cycle.

Autopilot is a **separate feature**, not a fourth numbered round: a boosted, multi-cycle version of cross-talk that the moderator configures and launches, and that runs until a stop condition is met. The same launcher is reachable from **every disagreement** (scoped to that one topic) and from the toolbar (scoped to the whole discussion).

### A2. Controls (one dialog, `#dlg-autopilot`)

| Control | Type | Range / values | Maps to |
|---|---|---|---|
| Scope | fixed by entry point | whole discussion · disagreement #n | instruction text |
| Agents | checkboxes | any subset, default all 3 | turn list per cycle |
| Response length | slider, 5 stops | 300 chars · 600 · 1,200 · 2,500 · As required | `max_tokens` + explicit sentence in the instruction ("Hard limit: N characters"); "As required" = `MAX_TOKENS_DIVE_DEEPER`, no length sentence |
| Interactions | slider | 3 … 20, last stop = ∞ (until unanimous) | cycle cap; ∞ still gets a hard safety cap (config `AUTOPILOT.max_cycles`, default 30) and a cost cap (`AUTOPILOT.max_cost_usd`) |
| Stop when unanimous | toggle, default on | | early exit on consensus (see A4) |
| Auto-resolve disagreement when unanimous | toggle, default on, only shown in disagreement scope | | PATCH `/disagreements/:n` → resolved |
| STANCE per agent | one slider per checked agent, 5 stops (very passive … very aggressive) | reads default from the agent profile field the other session adds; the value here is a per-run override only | stance sentence appended to that agent's instruction |

"Autopilot" wording in the UI: title "Autopilot", subtitle "Let the agents talk it out. Set the limits, then watch." Toolbar gets an `Autopilot…` button next to the existing cross-talk button. Disagreement modal gets a second submit button `Autopilot on this disagreement…`.

### A3. Conversation mechanics

- One **cycle** = each checked agent takes one turn, sequentially, each seeing everything before it (same as Round 2/3). Rendered as the existing 3-column `agent-grid` per cycle, with a cycle header row ("Cycle 3 of 8 · 2 of 3 agree").
- **Speaking order rotates** each cycle (R,C,Cm → C,Cm,R → …) so no agent always speaks first or always gets last word.
- New mode `autopilot` in `prompts/rounds.json`. Instruction body: respond only to the latest cycle, concede where evidence wins, do not repeat, and **end every message with one machine-readable line**:
  `POSITION: AGREE | DISAGREE — <one sentence>`
  In disagreement scope the sentence must name the disagreement topic.
- `COMPACT_SUFFIX` is *not* appended in autopilot mode; the length slider replaces it.
- Stance sentence bank (5 strings, keyed by slider stop) lives in `prompts/stance.json` so it is editable without a deploy. Wording waits on the rename session.

### A4. Stop conditions (client loop, server per-turn)

The loop lives in `public/app.js` as `runAutopilot(settings)` next to `runSequence`, because each turn must stay one HTTP request (Vercel 800 s cap). The server turn endpoint is unchanged apart from accepting `mode: 'autopilot'`, `max_chars`, `stance`, and `autopilot: { run_id, cycle }` and storing them in `content_json`.

Stops, checked after every cycle, first one wins:
1. Moderator pressed `Stop after this turn` (existing `state.stopRequested`).
2. A turn failed (existing behaviour: leave Retry, stop cascading).
3. Cycle cap reached.
4. Unanimous: every agent in the cycle ended with `POSITION: AGREE`. Parsed by regex on the stored text, no extra model call. If an agent omits the line, treat as DISAGREE and show a small "no position line" badge on that message.
5. Safety: `max_cycles` or `max_cost_usd` for this run exceeded (sum of `cost_usd` on the run's messages).

On stop, post a system note into the transcript (stored as `role: 'system'`, `speaker: 'autopilot'`) saying why it stopped and the final tally, so exports carry it.

### A5. Persistence

New table `autopilot_runs (id, session_id, scope, disagreement_n NULL, settings_json, cycles_run, outcome, cost_usd, started_at, ended_at)`. Messages link by `content_json.autopilot.run_id`. Needed so reports (Part B) can say "Disagreement #4 was argued over 6 cycles and settled" rather than re-deriving it.

### A6. Files touched

- `prompts/rounds.json` (+`autopilot`), `prompts/stance.json` (new)
- `src/prompts.js`: `turnUserMessage` handles `autopilot`, `max_chars`, `stance`
- `src/agents.js`: `maxTokens` from `max_chars` when given
- `src/app.js`: accept the new body fields; `role: 'system'` note endpoint or reuse `addMessage`
- `src/db.js`: migration for `autopilot_runs`
- `public/index.html` + `public/app.js`: dialog, toolbar button, disagreement-modal button, `runAutopilot`, cycle header, POSITION badge
- `src/export.js`: `modeLabel` gets `autopilot`; system notes render as a muted line
- `src/config.js`: `AUTOPILOT: { max_cycles: 30, max_cost_usd: 2, default_max_chars: 600 }`

### A7. Verification (each must be able to fail)

- Length: run 3 cycles at 300 chars; assert every autopilot message text ≤ 330 chars (10% slack). Then run at "As required" and assert at least one exceeds 1,000.
- Unanimity: stub the model with fixed replies (two AGREE, one DISAGREE) via a test model option; assert loop continues; flip to three AGREE; assert loop stops with outcome `unanimous` and the disagreement flips to resolved only when the toggle is on.
- Rotation: assert speaker order of cycle 2 ≠ cycle 1.
- Safety cap: set `max_cycles: 2`, interactions ∞; assert exactly 2 cycles ran.
- Stop button mid-cycle: assert no further turn starts after the current one.

---

## Part B — Interim and Final reports

### B1. Split

Today there is one deliverable: the 10-section DECISION OUTPUT, stored once on `sessions.decision_text`, 2,500–4,000 words, only meaningful after Round 3.

Split into two report kinds, each with a depth control:

| | Interim report | Final report |
|---|---|---|
| When | any time after Round 1 | after Round 3 (warn, don't block, if Round 3 missing) |
| Question it answers | "Where are we, what is still open?" | "What do we do?" |
| Recommendation | provisional, may be INSUFFICIENT INFORMATION | required, one of GO / GO WITH CONDITIONS / NO-GO / INSUFFICIENT INFORMATION |
| Stored | `reports` table, many per session | `reports` table, many per session; latest Full also mirrored to `sessions.decision_text` for backward compatibility |

### B2. Depth control (3 stops, both kinds)

| Depth | Target | Model of | Use |
|---|---|---|---|
| Brief | ~1 page, ≤ 450 words | one-page decision memo / BLUF | forwarding to a board member or sponsor |
| Standard | 3–5 pages, 1,000–1,800 words | steering-committee paper | working-group circulation |
| Full | 8–12 pages, 2,500–4,000 words | current 10-section output plus appendices | the record of decision |

Depth is enforced two ways: a word budget in the prompt, and `max_tokens` scaled per stop (Brief 2,000; Standard 6,000; Full `MAX_TOKENS_DECISION`).

### B3. Templates researched (from established formats; not web-verified this session)

- **BLUF / military decision brief** — Bottom Line Up Front; recommendation first, then supporting facts. Used for Brief depth of both kinds.
- **One-page decision memo** (Recommendation · Options considered · Rationale · Risks · Cost · Ask · Next steps) — common in pharma/biotech portfolio governance. Basis for Final/Brief.
- **Stage-Gate gate-review document** (Cooper) — Deliverables status, gate criteria met/unmet, go/kill/hold/recycle, open actions. Basis for Interim/Standard: our rounds are stages, disagreements are unmet criteria.
- **McKinsey SCQA / Pyramid Principle** — Situation, Complication, Question, Answer; supporting arguments grouped under one governing thought. Used for section ordering in Standard and Full.
- **Amazon 6-pager** — narrative, no bullets, FAQ appendix. Its FAQ section is borrowed as "Questions for local experts" in Interim.
- **Steering-committee status update** (RAG status per workstream, decisions needed, risks, next period plan) — basis for Interim/Brief and Interim/Standard.
- **Launch readiness review** (pharma) — function-by-function readiness (Regulatory / Medical / Market access / Commercial), each with RAG and blockers. Maps 1:1 onto our three agents; used for the per-function section in every Interim depth.

### B4. Section layouts

**Interim — Brief**: BLUF line (provisional view) · RAG per function (3 rows: Regulatory / Clinical / Commercial, each one sentence) · Open disagreements (count + top 3 topics) · Decisions needed from moderator · Next round recommended.

**Interim — Standard**: adds per-function findings (verified vs estimate vs unknown counts and top facts) · full disagreement log with status and, for autopilot-argued ones, cycles run · questions for local experts · inputs still marked INPUT MISSING · sources count.

**Interim — Full**: Standard plus verification appendix (same table format as decision §9) and a chronological round summary.

**Final — Brief**: Recommendation + the three driving facts · top 3 risks (one line each) · kill criteria (bullets) · investment range and breakeven year · next 5 actions. Nothing else.

**Final — Standard**: current 10 sections with §9 (verification appendix) reduced to counts and a link line "see Full report", each other section capped.

**Final — Full**: current `prompts/moderator.md` unchanged, plus a new §11 "Discussion record" summarising rounds and autopilot runs.

Implementation: one prompt file per kind, `prompts/report-interim.md` and `prompts/report-final.md`, each with `{{DEPTH}}` blocks the builder includes or drops. `prompts/moderator.md` becomes the Final/Full body to avoid drift.

### B5. Generation

- New mode `report` on the moderator speaker, body `{ kind: 'interim'|'final', depth: 'brief'|'standard'|'full' }`. Same SSE turn endpoint; streamed into a new right-panel tab **Reports**, not into the transcript (the transcript currently gets a "Decision output" message; keep that only for Final so old sessions render unchanged).
- Report metadata passed to the prompt beyond the transcript: disagreement list with statuses, autopilot run summaries, sources count, INPUT MISSING fields. Cheap to assemble server-side, saves the model re-deriving it.
- `reports` table: `(id, session_id, kind, depth, text, model, cost_usd, created_by, created_at)`.

### B6. Download

Extend `src/export.js`:
- `toDocx(session, { report })` and `toPdf(session, { report })`. With `report` set, the document is the report alone: title block (product · country · kind · depth · date · author email), then the markdown blocks, then a one-page "About this report" footer (session id, rounds run, model, cost). Without it, current full-transcript behaviour.
- Routes: `GET /api/sessions/:id/reports/:rid/export.(docx|pdf)`. Filename `<product>_<country>_<kind>-<depth>_<yyyymmdd>.docx`.
- Reports tab lists every report with Download DOCX / PDF / Email / Delete.

### B7. Email

- Provider: **Resend** (HTTPS API, works from Vercel, free tier 3,000/month, attachments up to 40 MB). Env: `RESEND_API_KEY`, `MAIL_FROM` (must be on a verified domain — user action). No SMTP, no nodemailer.
- Route: `POST /api/sessions/:id/reports/:rid/email` body `{ to: [emails], format: 'pdf'|'docx'|'both', note }`. Server renders the attachment(s) in-process, sends, and logs to `report_emails (id, report_id, to_json, format, sent_by, provider_id, created_at)`.
- Recipients: picker pre-filled from the `users` table (any registered user) plus a free-text email field. "Any user" in the request is read as: any registered user selectable in one click, and arbitrary addresses allowed.
- Email body: short plain-text cover (kind, depth, product, country, sender, optional note) with the report's BLUF paragraph pasted in, attachment(s) below. Written in normal prose, no app jargon.
- Feature-flag: if `RESEND_API_KEY` is empty, the Email button shows a tooltip "Email not configured" and the route returns 503.

### B8. UI

Toolbar: the single `Write the decision output` button becomes `Reports ▾` with `Interim report…` and `Final report…`. Each opens `#dlg-report` with the depth slider (3 stops, labelled with page estimate) and a Generate button. Design tokens from `design-system/MASTER.md`; the ui-ux-pro-max skill must be loaded before writing any UI in the build stage per the global instructions.

### B9. Verification (each must be able to fail)

- Depth: generate Final at each depth on one session; assert word counts fall in the three bands (Brief ≤ 450, Standard 1,000–1,800, Full 2,500–4,000). Deliberately request Brief with a Full-sized budget once to watch it fail.
- Kind: Interim on a session with no Round 3 must succeed; Final must show the warning and still run.
- Export: report-only DOCX extracted text must contain the report's first heading and must NOT contain any Round 1 message text; full export must contain both.
- Email: send to the tester's own address with format `both`; assert Resend returns an id, `report_emails` has a row, and the received PDF's page count matches the one generated for download. Then send with `RESEND_API_KEY` blank and assert 503 and no row.
- Backward compat: an old session with `decision_text` and no `reports` rows still renders its decision message and still exports.

---

## Part C — Build order and estimates

1. DB migrations: `autopilot_runs`, `reports`, `report_emails` (½ day)
2. Part A server side: rounds.json, stance.json, prompts.js, agents.js max_tokens, app.js body fields (½ day)
3. Part A client: dialog, `runAutopilot`, stop conditions, cycle header, POSITION badge, disagreement entry point, auto-resolve (1–1½ days)
4. Part B prompts + `report` mode + Reports tab + streaming (1 day)
5. Exports report-only variant + routes (½ day)
6. Email via Resend + recipient picker + log (½ day, plus user's domain verification)
7. Verification passes A7 and B9, todo.md review section (½ day)

Total roughly 4½–5 days. Parts A and B are independent after step 1 and can be built in either order.

## Part D — Open questions for the user (not blocking the build start)

1. STANCE: confirm final field name and storage from the other session before step 2.
2. Sending domain for Resend: `slapharmagroup.com`? Someone with DNS access must add the records.
3. Auto-resolve on unanimous: default on (as planned) or default off?
4. Should Interim reports also post a message into the transcript, or live only in the Reports tab (planned: tab only)?
5. Cost cap default for an ∞ autopilot run: $2 planned; adjust if paid models become the norm.
