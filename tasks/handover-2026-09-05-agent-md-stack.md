# Handover — agent md stack, personas, and two feature plans

Session date: 2026-09-05. Repo: `slapharma/AnatopTerritorySimulator`, branch `main`. Everything below is pushed; latest commit from this session is `5ad8fa7`.

Note: several other Claude sessions were committing to this same working tree concurrently throughout. Commits `8612b5b`, `ac23cc4` and `a3b8041` are theirs, not this session's. Pull before you start.

## 1. What this session delivered

### Two plan documents (committed in `e3115f3`)
- `tasks/plan-autopilot-and-reports.md` — design for (a) an "Autopilot" multi-cycle round where agents talk it out under moderator-set limits, launchable session-wide or per disagreement, and (b) splitting the single decision output into Interim and Final reports at three depths, downloadable and emailable.
- `tasks/plan-agent-personas.md` — design for named, sourced, file-backed agent personas with an extensible roster. User decisions are recorded in its section 8.

### The md stack (built, then wired in `5ad8fa7`)
Files under `prompts/agents/`:
- `index.json` — roster manifest. Three agents plus the moderator entry. Adding an agent is a new folder plus one entry here.
- `_template/` — skeleton `persona.md`, `questions.md`, `cv.md` with instructions.
- `regulatory/`, `clinical/`, `commercial/` — each with `persona.md` (identity and voice), `questions.md` (standing questions), `cv.md` (career record, source URLs, verification note at top).
- `prompts/stance.json` — five challenge levels, Supportive to Adversarial, with the sentence substituted into each persona.
- `prompts/evidence-rules.md` — extended with a mandatory `## Slides` block at the end of every agent response, and the closing `**Next step:**` line moved inside the last slide.

Personas (all fictional people; institutions and dates are real and public):
- Regulatory: Dr. Yoon Seo-jin, director-level MFDS official, in the room off the record.
- Clinical: Dr. Margaret Okafor-Lindqvist, ex-senior clinical-development lead at a global CRO, now independent.
- Commercial: Henrik Waldenström, thirty years pharma commercial and market access, ex-country GM, now board advisor.

All three are framed as outside experts who want SLA to succeed, impartial, challenging, and required to pair every problem with a fix.

### Code wiring (`5ad8fa7`)
- `src/prompts.js` — `AGENTS` and `AGENT_ORDER` now derive from the manifest. `personaFor()` reads `persona.md` + `cv.md` (verification note stripped) + `questions.md`, substitutes `{{STANCE_TEXT}}` from the DB row's `stance_default`, then appends the DB `knowledge` overlay. New exports: `STANCE`, `personaFilesRaw()`.
- `src/db.js` — `updateAgent()` now accepts `knowledge`, `can_web_search`, `can_open_url`, `stance_default`. It no longer writes `description` or `role`; those columns still exist but are not read for prompt content.
- `src/app.js` — `GET /api/agents` returns each row plus a `persona_preview` of the file text. New `GET /api/stance-levels`. `PATCH /api/agents/:key` takes the overlay fields only.
- `public/agents.html` — persona, background and questions shown read-only with a note to edit the files and commit. Editable: challenge-level slider, knowledge, tool abilities.
- Supabase migration `add_agent_stance_default` — `agents.stance_default integer NOT NULL DEFAULT 3 CHECK 1..5`. Applied to project `unqexnqlxdmlglyuzyfs`.

### Verification run this session
- `node --check` on the three edited `src/*.js` files.
- Manifest and persona composition loaded without the DB.
- Full `systemPrompt()` built against the live Supabase DB for all three agents with South Korea and with Vietnam as the country. Both produced the substituted country, no leftover `{{...}}` placeholders, no Korea-specific text leaking into the Vietnam prompt.
- Not verified: the Agents page in a browser, and a live model turn with the new personas. Neither has been exercised since the wiring landed.

## 2. Decisions made with the user

1. Keep the three proposed persona names.
2. The Regulatory persona is a current ministry official, off the record.
3. No disclosure line on exports; internal tool.
4. Slides blocks are reused as the Interim report's per-function section when reports are built.
5. Country-pack mechanism dropped mid-build on the user's instruction. The agent stack is country-agnostic: `{{COUNTRY}}` comes from the session inputs and every country-specific fact is found by the agent's own search each turn. The `countries/` folders were deleted; the plan was amended to match.

## 3. Open items, in priority order

1. **Front end and exports still hardcode three agents.** `public/app.js` has `ALL`, `AGENT_LABEL`; `src/export.js` has `COLOURS`. Harmless while the roster is exactly regulatory, clinical, commercial. A fourth agent needs those switched to read `/api/config.agents`. Plan section 5 describes the change.
2. **Live turn not yet run with the new personas.** Run the Korea example Round 1 and check that each response ends with a `## Slides` block, speaks in first person by name, and does not say "we at SLA". Plan section 7 lists the checks that can fail.
3. **Slides rendering.** The prompt now demands a Slides block, but nothing in `public/app.js` or `src/export.js` renders it specially yet. It will appear as plain markdown headings until that is built. Plan build-order step 5.
4. **Clinical `cv.md` verification pass.** The regulatory and commercial CVs were anchored to facts checked by search this session (MFDS 2013 rename, PIC/S 2014, HIRA/NHIS process, one real Kwangdong in-licensing deal used only to confirm the deal type). The clinical CV's specific CRO name and Korean CRO references were not individually re-verified. The file says so in its header.
5. **STANCE rename.** Another session was renaming the "aggressive/passive" control. This session used `stance_default` and `prompts/stance.json`. If that other session lands a different name, reconcile to one.
6. **Legacy files.** `prompts/regulatory.md`, `prompts/clinical.md`, `prompts/commercial.md` at the top level are now dead; nothing reads them. Safe to delete once the live turn in item 2 passes.
7. **Autopilot and reports** are plans only from this session. Other sessions have already created `autopilot_runs`, `reports` and `report_emails` tables and `src/email.js` (Resend), so parts of both plans are underway elsewhere. Check with those sessions before starting either.

## 4. Security flag, pre-existing, not touched

Row Level Security is disabled on all twelve tables in the Supabase project, including `users` and `sessions`. Anyone holding the anon key can read or write every row. This was reported by the Supabase tooling while adding the `stance_default` column; it predates this session and nothing here changed it. Enabling RLS without policies would block the app, so it needs a deliberate decision by whoever owns auth, not a quick toggle.

## 5. Where things are

- Plans: `tasks/plan-autopilot-and-reports.md`, `tasks/plan-agent-personas.md`.
- Persona files: `prompts/agents/`.
- Stance levels: `prompts/stance.json`.
- Coordination notes from other sessions: `tasks/coordination-cb.md`, `tasks/audit-2026-09-05.md`.
- Push routing: this repo is owned by `slapharma`; run `gh auth switch --user slapharma` before pushing.
