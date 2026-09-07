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

> **Updated 2026-09-07.** The regulatory persona below has since been rewritten. See
> "Corrections" at the end of this document before relying on this section.

Personas (all fictional people; institutions and dates are real and public):
- Regulatory: originally Dr. Yoon Seo-jin, director-level MFDS official, in the room off the record. **Superseded** - the persona is now anonymous ("the Regulator") and country-agnostic; see Corrections.
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
2. ~~**Live turn not yet run with the new personas.**~~ **Done 2026-09-07** (`5d18178`). Korea Round 1 run live for all three agents. Slides blocks, first person, no "we at SLA" and no unsubstituted placeholders all passed first time. Two things failed and were fixed: none of the three introduced itself (the clinical agent signed as "Clinical Agent"), and two of three opened with a process preamble. `prompts/rounds.json` now asks for a one-line self-introduction in Round 1, and the no-preamble rule in `evidence-rules.md` was promoted from a clause to its own rule.
3. ~~**Slides rendering.**~~ **Done 2026-09-07** (`89af3c2`). `tagSlides()` in `src/markdown-blocks.js` retags the deck for both exporters; the client renders it as a card per slide. DOCX gets a ruled label and shaded numbered titles, PDF the same.
4. ~~**Clinical `cv.md` verification pass.**~~ **Moot as of 2026-09-07.** The CV was rewritten country-agnostic, and its header now states that no specific employer, trial, country programme or national GCP regime is asserted - so the unverified CRO and Korean-CRO references that needed checking are gone rather than confirmed.
5. ~~**STANCE rename.**~~ **Resolved.** One name survived: `prompts/stance.json` -> `prompts.STANCE` -> `agents.stance_default`. No `stanceBank()` remains anywhere in the tree.
6. ~~**Legacy files.**~~ **Deleted 2026-09-07** (`16aef58`), once item 2 passed. Every question in them was confirmed to survive verbatim in the matching `questions.md` first.
7. ~~**Autopilot and reports** are plans only from this session.~~ **Both shipped** by the worktree session (`d667ecb`, merged `62934e9` and `b707f44`). Still open there: no report email has ever actually been sent (`RESEND_API_KEY` and `MAIL_FROM` unset, sending domain undecided), and the Autopilot stance slider still opens at the bank default rather than each agent's `stance_default`.

Item 1 is the only one of these seven still fully open.

## 4. Security flag, pre-existing, not touched

Row Level Security is disabled on all twelve tables in the Supabase project, including `users` and `sessions`. This was reported by the Supabase tooling while adding the `stance_default` column; it predates this session and nothing here changed it. Enabling RLS without policies would block the app, so it needs a deliberate decision by whoever owns auth, not a quick toggle. Still true on 2026-09-07: Supabase's linter reports it on all twelve.

**Severity correction, 2026-09-07.** The original wording here - "anyone holding the anon key can read or write every row" - reads as an active exposure and overstates it. There is no Supabase client, no anon key and no project URL anywhere in `public/`; the app connects over `DATABASE_URL`, a server-side Postgres connection string (`src/db.js:8-10`). So the PostgREST surface is only reachable by someone who already has the anon key, which this app never publishes. It remains a genuine ERROR-level finding, because an anon key is designed to be public in normal Supabase apps and leaks easily - but it is not currently exploitable from this app. Since the app never uses PostgREST, enabling RLS with a deny-all policy is the cheap correct fix; verify on one low-traffic table first.

## 5. Where things are

- Plans: `tasks/plan-autopilot-and-reports.md`, `tasks/plan-agent-personas.md`.
- Persona files: `prompts/agents/`.
- Stance levels: `prompts/stance.json`.
- Coordination notes from other sessions: `tasks/coordination-cb.md`, `tasks/audit-2026-09-05.md`.
- Push routing: this repo is owned by `slapharma`; run `gh auth switch --user slapharma` before pushing.

---

## 6. Corrections (added 2026-09-07)

Written by a later session after auditing this document against the tree. The
body above is left as it was written; these are the points where it no longer
describes reality.

**The regulatory persona is anonymous now, not Dr. Yoon Seo-jin.**
`prompts/agents/regulatory/persona.md` reads: *"You are **the Regulator**... You
give no personal name and are addressed simply as 'the Regulator'... Do not
invent a name for yourself, and do not let anyone assign you one."* The name and
the MFDS-specific career history were both removed as part of the
country-agnostic rewrite recorded in section 2, decision 5 - the persona is a
director-level official at whichever regulator `{{COUNTRY}}` implies, and states
that agency's specifics only after confirming them by search in the turn.

This matters because it is a testable claim that fails. A live run on 2026-09-07
checked the regulatory output for "Yoon" and reported a failure; the output was
correct and the expectation was stale. Clinical (Dr. Margaret Okafor-Lindqvist)
and commercial (Henrik Waldenstrom) do still carry their fixed names, and both
introduce themselves by name.

**Section 4's RLS wording overstated the exposure.** Corrected in place above.

**Commit trail for the items closed since this handover was written:**
`89af3c2` Slides rendering, `7fc0f19` OpenRouter strings, `5d18178` Round 1
self-introduction and no-preamble, `16aef58` legacy prompt files deleted.
Current status of everything open across all sessions is in
`tasks/plan-converged-2026-09-07.md`.
