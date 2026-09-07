# Converged plan — 2026-09-07

Audit and convergence of three handovers from parallel sessions, checked against the
actual working tree at `531e1ea` (in sync with `origin/main`, clean).

Sources reconciled:
- Artifact "Audit fix pass, Days 1–3, and the deploy that followed" (audit-fix session).
- Artifact "Autopilot & Reports" (worktree session).
- `tasks/handover-2026-09-05-agent-md-stack.md` (persona/md-stack session).
- `tasks/audit-2026-09-05.md` (the 42-item source audit), `tasks/coordination-cb.md`.

Every claim below was re-checked in the repo, the Supabase project, or both. Where a
handover's claim did not survive that check, it is called out.

---

## 1. Audit of the handovers

### 1.1 Corrections to the handovers

**The audit-fix handover's completion record is incomplete.** It reports "Days 1–3
complete" against `tasks/audit-2026-09-05.md` and lists only items 33, 37, 38 and 39 as
outstanding. Items **24, 25, 26, 40, 41 and 42 are never mentioned in it at all** and are
still open in the tree:

| Item | Claim | Verified state |
|---|---|---|
| 24 | Stale Anthropic jargon; backend is OpenRouter | Open. `public/app.js:692` "check the Anthropic console for billing"; `public/app.js:1239` "Add ANTHROPIC_API_KEY to .env"; `public/index.html:50` "Section 0 of the spec". All three actively misinform the user — the backend is OpenRouter. |
| 25 | Naming inconsistent (session/turn/simulation/evaluation) | Open, not addressed. |
| 26 | ALL-CAPS labels, budget in USD vs evidence rules' local+GBP | Open, not addressed. |
| 40 | No `sql/schema.sql`; legacy prompt files dead | Open. No `sql/` directory exists. `prompts/{regulatory,clinical,commercial}.md` still present, referenced only by a stale comment at `src/prompts.js:73`. |
| 41 | Search results carry no date, so "within 3 years" is unenforceable | Open. No date or published field anywhere in `src/search.js`. |
| 42 | `rejectUnauthorized: false`; raw pg errors returned to client | Open. `src/db.js:10` still disables cert verification; raw `err.message` reaches the client at `src/app.js:471` and `src/app.js:713`. |

This is not a criticism of the work done — items 1–23 and 27–37 were spot-checked and are
real. It is a gap in the record, and the gap is what a reader would act on.

**The two handovers disagree on the severity of the RLS finding, and the audit-fix
handover is the correct one.** The persona handover says "anyone holding the anon key can
read or write every row", which reads as an active exposure. Verified: there is no
Supabase client, no anon key and no project URL anywhere in `public/`. The app connects
over `DATABASE_URL` (a server-side Postgres connection string) at `src/db.js:8-10`. So the
PostgREST surface is only reachable by someone who already has the anon key, which this
app never publishes. Still a genuine ERROR-level finding — Supabase's linter reports it on
all 12 tables, re-confirmed live today — because an anon key is designed to be public in
normal Supabase apps and leaks easily. Real, but not currently exploitable from this app.

**One item is already closed and can be struck from the open list.** Persona handover open
item 5, the STANCE naming reconciliation: verified done. One name survived
(`prompts/stance.json` → `prompts.STANCE` → `agents.stance_default`); `stanceBank()` no
longer exists anywhere in the tree.

**Both handovers report HEAD as `b707f44`.** Actual HEAD is `531e1ea`, two commits later
(`8662529` handover doc, `353544f` report-dialog wording fix). No conflict — the handovers
are simply a little stale.

### 1.2 What both handovers agree on, and is confirmed

- Autopilot (Part A) and Interim/Final reports (Part B) shipped and merged; three new
  tables exist and are additive.
- The `pg` pool `'error'` listener fix is in the tree (`src/db.js:17`) — an idle
  connection drop no longer kills the process.
- The vendor-route 404 (`marked.js` / `dompurify.js`) is fixed via `{dotfiles:'allow'}`.
- The file-backed persona stack is wired and country-agnostic.
- The worktree at `.claude/worktrees/autopilot-reports` still exists, at the same commit
  as `main`, and is safe to remove.

### 1.3 The most serious open issue, which neither handover ranks highly

**The `## Slides` block is mandated by the prompt and rendered by nothing.**
`prompts/evidence-rules.md:30` requires every agent response to end with a Slides block,
and moves the single most important line (`**Next step:**`) *inside* it. A search for
"Slides" across `public/app.js`, `src/export.js` and `src/markdown-blocks.js` returns
**zero hits**.

That means: since `5ad8fa7` shipped, every agent response in production ends with a raw
markdown block the UI does not understand, and the closing takeaway — the thing the
renderer used to pull out and badge — has been relocated inside it. This is a live
regression on the current deployment, introduced by a prompt change whose matching
renderer change was never built. The persona handover files it as open item 3; the
audit handover does not mention it. It belongs at the top.

---

## 2. Converged open-issue register

Priority is by user-visible harm, then by cost of leaving it.

### P0 — live regressions and misinformation

1. **Render the `## Slides` block** (`public/app.js`, `src/export.js`). Either build the
   renderer or revert `prompts/evidence-rules.md` to the previous closing-line contract.
   Whichever is chosen, the closing takeaway must be visible again. Gate: run a real turn
   and read the rendered card, not the raw text.
2. **Run one live turn with the new personas** — the Korea example, Round 1, all three
   agents. Check each response speaks in first person by name, does not say "we at SLA",
   and ends with a well-formed Slides block. This is the gate on items 1 and 12 below, and
   nothing has exercised the personas since the wiring landed.
3. **Fix the stale Anthropic references** (audit item 24). Three strings tell the user to
   set `ANTHROPIC_API_KEY` and check the Anthropic console. The backend is OpenRouter. A
   user following that text cannot make the app work.

### P1 — correctness and security

4. **Raw pg errors to the client** (audit item 42, `src/app.js:471`, `src/app.js:713`).
   Log the detail server-side, return a generic message with a correlation id.
5. **`rejectUnauthorized: false`** (audit item 42, `src/db.js:10`). Pin Supabase's CA
   rather than disabling verification.
6. **Search results carry no date** (audit item 41). The evidence rules demand sources
   within three years and there is no field to enforce it against. Either capture the
   published date from the provider or drop the recency claim from the rules — an
   unenforceable rule in a prompt is worse than no rule.
7. ~~**RLS decision.**~~ **Done 2026-09-07.** RLS is enabled on all twelve tables, each
   with a single policy granting the application's own role and nobody else; Supabase's
   security advisor now returns zero findings. Migrations `rls_pilot_agents` and
   `rls_enable_remaining_tables`.

   Two things found on the way in that contradict what this plan and both handovers said,
   and that matter more than the change itself:

   - **The exposure described was never real.** `anon` and `authenticated` hold no grants
     at all on any of the twelve tables — only `app_user` does. PostgREST would have
     refused on privileges before RLS was ever consulted, so holding the anon key got
     nobody anything. The Supabase linter flags `rls_disabled_in_public` on the RLS flag
     alone and does not look at grants. Both handovers, and this plan's own P1 item 7,
     overstated it.
   - **A literal deny-all would have taken the application down.** The app connects as
     `app_user`, which is not the table owner, is not superuser and has no `BYPASSRLS`, so
     RLS applies to it in full. The policy is therefore scoped to `app_user` rather than
     denying everyone: every other role is still denied by omission, since with RLS on and
     no policy naming a role, that role sees nothing.

   So the value delivered is defence in depth, not the closing of a live hole: an
   accidental future `GRANT ... TO anon` no longer becomes an exposure on its own.

   Verified rather than assumed. RLS was enabled on `agents` alone first; the app still
   read and wrote it, while a throwaway role holding `SELECT` on both `agents` and `users`
   saw 0 rows in `agents` and 2 in `users` — the control that rules out "the probe simply
   cannot read". After the rollout, all twelve tables are readable by the app, and a full
   create/insert/read/delete cycle through the app's own functions succeeds and leaves
   nothing behind.

### P2 — extensibility, blocked on nothing

8. **De-hardcode the agent roster in the front end.** `public/app.js:20` (`AGENT_LABEL`),
   `:137`, `:758`, `:978` (`ALL`), and `src/export.js:10` (`COLOURS`). `/api/config`
   already returns `agents` and `agent_order`, and `prompts/agents/index.json` already
   carries `label`, `short` and `colour` per agent — so this is a read-from-config change,
   not a design problem. Do it before anyone adds a fourth agent, not after.
9. **Autopilot stance slider ignores `stance_default`.** `autopilotStanceRows()` in
   `public/app.js` hardcodes `value="2"`. It should open at each agent's own profile
   default now that the column is real. `stance_default` is not currently in the
   `/api/config` agents payload — check whether `GET /api/agents` needs to be read here.
10. ~~**Clinical `cv.md` verification pass.**~~ **Done 2026-09-07.** The country-agnostic
    rewrite had already removed most of what needed checking; what remained was the four
    named CROs and the two ICH references, and both were verified by search rather than
    softened. All four CROs are real and currently trading as CROs — each company's own
    site was opened and each self-describes as one. Two changed hands since 2021 (ICON
    absorbed PRA Health Sciences; PPD was acquired by Thermo Fisher), neither of which
    affects the claim being made, and the PPD ownership detail is recorded as
    secondary-sourced because it did not appear on ppd.com's own homepage. ICH E5 was
    confirmed from the FDA's guidance listing under exactly the bridging framing the CV
    uses. The header now records what was checked, against what, and what is not asserted.

    Checked at the same time: the regulatory and commercial CV headers, which the same
    rewrite could have left claiming Korea-specific verification for facts no longer in
    the files. Both are already accurate, and no Korea reference survives in any CV.
11. ~~**Add `sql/schema.sql`**~~ **Done 2026-09-07.** `sql/schema.sql` now holds all twelve
    tables with their constraints, indexes, RLS flags and policies, plus the grants and a
    minimal seed. Generated by introspecting the live database, not written from memory,
    then verified by applying it to an empty schema and diffing against live: 106 columns,
    26 constraints, 21 indexes, 12 RLS flags and 12 policies all identical, and re-running
    it is a no-op. The diff was confirmed able to fail by injecting four faults — a
    dropped column, a dropped index, a table missing from the RLS list and a widened CHECK
    — each of which it caught in the right category.

    Two oddities are reproduced faithfully rather than silently corrected, and flagged in
    the file: `meeting_minutes.id`/`session_id` are `integer` where every other table uses
    `bigint`, and `agents.role` is NOT NULL with no default while the neighbouring
    `description` has one.
12. **Delete the legacy prompt files** `prompts/{regulatory,clinical,commercial}.md` and
    the stale comment at `src/prompts.js:73`. Blocked on item 2 passing.
13. **Remove the merged worktree** at `.claude/worktrees/autopilot-reports`.

### P3 — UX, from the audit's own leftovers

14. **Mobile ≤900px** (audit item 33). Partially addressed — `public/styles.css:314`
    collapses the grid and hides the sidebar, but hiding the sidebar with no replacement
    navigation means there is no way to start a new session on a phone. Topbar overflow
    and the hidden right panel are untouched.
15. **Native `prompt()`/`confirm()`** (audit item 37). Five sites remain in
    `public/app.js` (546, 1140, 1273, 1403, 1407).
16. **Guide rewrite** (audit item 38) — explain how to read GO WITH CONDITIONS and the
    trust badges, not which button does what.
17. **Branded login page** (audit item 39) — currently the raw Basic Auth browser dialog.
    Note this also blocks browser-based verification of any UI work (the Autopilot session
    could not click through its own feature for exactly this reason), so it buys more than
    polish.
18. **Naming and label consistency** (audit items 25, 26).

### Blocked on someone else

19. **Resend sending domain.** `RESEND_API_KEY` and `MAIL_FROM` unset; only the 503
    not-configured path has ever run. Needs DNS access to verify a domain in Resend.
    Report email cannot be tested until then.

### Spec gaps, unstarted

The audit's own "Spec gaps" section is untouched by all three sessions: §2 moderator as
process controller, §3 Round 3 agreement step, §4 verification appendix as its own
artefact, §0 removed REGULATOR / REIMBURSEMENT BODIES inputs. Flagging, not scheduling —
these are product decisions, not defects.

---

## 3. Suggested order

**First sitting — stop the bleeding.** Items 1, 2, 3. All three are visible to a user of
the current deployment, and item 2 is a prerequisite for trusting anything else about the
persona stack.

**Second — security and correctness.** Items 4, 5, 6, then the RLS decision (7) once
someone owns it.

**Third — extensibility while it is still cheap.** Items 8 and 9, then housekeeping 10–13.

**Fourth — UX.** Item 17 first, because it unblocks browser verification for everything
else in that group, then 14, 15, 16, 18.

## 4. Working notes for whoever picks this up

- Repo is `slapharma/AnatopTerritorySimulator`. Run `gh auth switch --user slapharma`
  before pushing.
- Supabase project ref `unqexnqlxdmlglyuzyfs`. Three tables (`autopilot_runs`, `reports`,
  `report_emails`) plus `sessions.owner_id`, `agents.stance_default` and the RLS policies
  from item 7 exist only as live migrations — see item 11.
- The application's database role is `app_user`, and it is deliberately not the owner and
  has no `BYPASSRLS`. Any future RLS work has to name that role explicitly or the app
  loses access to its own data.
- Two `agents.knowledge` rows were edited live (regulatory: PV + supply chain; commercial:
  IP + pricing reconciliation). Nothing in a deploy restores those if the row is reset.
- Verification standard for this plan: every check must be one that can fail. An HTTP 200
  from this app proves nothing about rendering; assert on content.
