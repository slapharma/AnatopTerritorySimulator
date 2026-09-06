# Plan: Named agent personas from md files, extensible agent roster

Status: PLAN ONLY (2026-09-05). Nothing below is built.

Related: `tasks/plan-autopilot-and-reports.md` (STANCE control, autopilot). The "how challenging" setting in this plan and STANCE there are the same control. Build one, not two.

## 1. Current state and what changes

Today: `prompts/{regulatory,clinical,commercial}.md` are seeds only. Live personas come from the `agents` DB table (`description`, `role`, `knowledge`, tool flags), editable on the Agents page. `moderator.md` is file-based. Agents are hard-coded as three keys in `src/prompts.js` (`AGENTS`, `AGENT_ORDER`) and the front end (`ALL`, colours, filter chips, composer "To:" list, 3-column grid).

Target:
- **Files are the source of truth for the persona.** One folder per agent: `prompts/agents/<key>/persona.md` (who they are), `questions.md` (their standing questions), `cv.md` (career record with sources). Versioned in git, reviewable in diffs.
- **DB row is an overlay only:** `knowledge` (free-text additions), `stance_default` (1 to 5), `enabled`, tool flags. `description` and `role` columns stop being edited; the Agents page shows the file text read-only with a note "edit in prompts/agents/<key>/".
- **Roster is a manifest**, `prompts/agents/index.json`, and everything that enumerates agents reads it. Adding an agent = new folder + one manifest entry, no code change.

## 2. Persona design rules (apply to every agent)

1. **Not SLA employees.** Each is an outside expert invited to the working group, motivated to see SLA succeed, but with their own institution's perspective and reputation to protect. State this in the persona.
2. **Impartial, challenging, solution-driven.** Every objection must come with the condition under which it goes away or the route around it. Prompt line: "Never leave a problem on the table without the cheapest credible fix or the fact that would remove it."
3. **Real meeting voice.** First person, addresses others by first name, refers to own past cases ("when we took X through Y in 2019"), no headings mid-flow beyond what the evidence rules need. Interrupts and concedes like a person.
4. **Slides at the end.** Every response ends with a block:

   ```
   ## Slides
   ### Slide 1 — <title>
   - bullet
   - bullet
   ### Slide 2 — …
   ```
   Two to four slides, max five bullets each, no new facts (summary only). Front end renders the block as slide cards; exports render each slide as a boxed panel; the existing `**Next step:**` / `**Conclusion:**` closing block moves *inside* the last slide so there is one ending, not two.
5. **Fictional person, real world.** The name is invented. The employers, agencies, transactions, trials, guidelines and dates in the CV are real and public. Each CV line carries a source URL, and the build step verifies every line by web search before it is committed. **Never use a real individual's name, and check the invented name against the named post** (e.g. search "MFDS director <name>") to make sure it does not collide with a real office-holder. The CV must not claim the persona personally *led* a specific real deal in a way that implies a real identifiable person; use "on the team that", "advised", "sat on the review panel for".
6. **No disclosure line.** Internal tool; user decided 2026-09-05. Persona fiction is understood by all users.
7. **Country-agnostic by design (revised 2026-09-05).** No country-pack branching. `persona.md` and `cv.md` are fixed regardless of session; a CV may reference real career history tied to a specific country (illustrative background only) but that never gates what the agent can say about a *different* country in a live session. {{COUNTRY}} is set per session from the user's own inputs, and every country-specific fact (which regulator, which HTA body, which guideline) is identified fresh by the agent's own search on its first step each turn (see questions.md and evidence-rules.md). No `countries/` folder, no fallback pack.

## 3. Challenge level (= STANCE)

One integer 1 to 5 per agent, default in the DB row, per-run override in the autopilot dialog and in the custom-round dialog.

| Level | Label | Behaviour sentence appended to the turn |
|---|---|---|
| 1 | Supportive | Accept the other agents' evidence unless it is clearly wrong; focus on making the plan work. |
| 2 | Constructive | Raise the one or two issues that matter most; offer the fix with each. |
| 3 | Balanced (default) | Challenge every unsupported claim once; concede when shown evidence; always pair a problem with a route around it. |
| 4 | Demanding | Assume the plan fails unless shown otherwise; require a source or a named expert for every load-bearing claim; still give the route around. |
| 5 | Adversarial | Act as the toughest reviewer this proposal will meet in {{COUNTRY}}; find the kill criteria first; concede nothing without a primary source. |

Text lives in `prompts/stance.json` (shared with autopilot). At any level the "solution-driven" rule still holds; level changes how hard they push, not whether they help.

## 4. The three personas (proposed; CV lines are candidates the build step must verify or replace)

### 4.1 Regulatory — "Dr. Yoon Seo-jin" (윤서진)
- Post: Director-level official in the pharmaceutical evaluation side of the Ministry of Food and Drug Safety (MFDS), Cheongju. In the room in a personal capacity, off the record.
- Background candidates to verify: PharmD Seoul National University; 20+ years across the Korea FDA (KFDA) to MFDS renaming (2013); worked on Korea's PIC/S accession (2014) and ICH membership (2016); involved in the reliance / expedited review provisions for products approved by reference regulators; reviewer on topical and dermatology dossiers; GMP inspection coordination with foreign sites.
- What they bring: knows the review clock versus real elapsed time, what deficiency letters actually say, which abridged routes exist for an active already approved in Korea.
- Any country: agent identifies the actual national regulator by name and source on its first step every turn; nothing about a specific country is hardcoded.

### 4.2 Clinical — "Dr. Margaret Okafor-Lindqvist"
- Post: 25+ years in clinical operations; most recently Senior VP Clinical Development at a top-tier global CRO (candidates: IQVIA, Parexel, ICON, PPD) with Asia-Pacific delivery responsibility; earlier a CRA and then project director. Consults independently now.
- Background candidates to verify: ran or oversaw multinational gastroenterology and coloproctology trials; familiar with ICH E5 bridging decisions in Korea and Japan; worked with Korean site networks and a Korean CRO (candidates: LSK Global PS, Dream CIS) on local bridging studies; knows KGCP and MFDS IND timelines; has designed low-systemic-exposure topical programmes.
- What they bring: whether the pivotal data fits, what a local study would actually cost and take, which KOLs and societies matter (Korean Society of Coloproctology and guideline history).

### 4.3 Commercial — "Henrik Waldenström"
- Post: 30 years in pharma commercial and market access, multiple C-level and country-GM roles in Asia-Pacific; sat on both sides of licensing and distribution deals for specialty and primary-care brands; now a board advisor.
- Background candidates to verify: country manager Korea for a mid-size European or Japanese pharma; led or advised on Korean in-licensing / co-promotion deals with domestic players (Kwangdong, Hanmi, Daewoong, Yuhan, Boryung as candidate counterparties in public deals); took products through HIRA economic evaluation and NHIS price negotiation; has launched non-reimbursed private-pay products in Korea.
- What they bring: entry model economics, HIRA/NHIS reality versus the statute, what a domestic partner will and will not pay for, a P&L skeleton from real comparables.

### 4.4 Moderator assistant
Unchanged in identity (non-voting, writes reports). Gains slide-aware parsing; Interim reports reuse each agent's latest Slides block as the per-function section, no extra model call.

## 5. Provision for additional agents

Manifest entry:
```json
{ "key": "market_access", "label": "Market Access Agent", "short": "Access", "colour": "#7c5cbf",
  "order": 4, "enabled": true, "grid": true, "in_round1": true }
```
- `src/prompts.js`: `AGENTS`, `AGENT_ORDER` built from the manifest at startup; `personaFor` reads `persona.md` + `questions.md` + `cv.md` + DB overlay (no country branching).
- `src/db.js`: seed inserts a row for any manifest key missing from `agents`.
- Front end: `ALL`, colours, filter chips, composer "To:" options, custom-round and disagreement checkboxes, and the column grid all come from `/api/config.agents`. Grid becomes `repeat(auto-fit, minmax(320px, 1fr))` so four or five columns degrade to two rows instead of breaking.
- Exports: `COLOURS` in `src/export.js` from the manifest.
- `prompts/agents/_template/` with the three files pre-filled with instructions, so a new agent is copy, rename, fill.
- Candidate future agents (not built now): Market Access / HTA specialist (split from Commercial), Medical Affairs / KOL, Supply and Quality (QP, import licence, serialisation), Legal / IP, Patient advocate.

## 6. Build order

1. Manifest + folder layout + `_template`; move existing three md files into folders unchanged. Code reads from the manifest. Verify: app runs identically, Agents page still loads. (½ day)
2. Research pass, one agent at a time: build `cv.md` with a source URL per line, run the name-collision check, record verification results in the file header. (1 day, mostly search)
3. Write `persona.md` for the three, including meeting voice, non-employee framing, solution rule, slides rule. Write `questions.md` from the current question lists. Default pack (South Korea). (½ day)
4. Stance: `stance.json`, DB column `stance_default`, Agents page slider, per-run override plumbing in `turnUserMessage`. Coordinate with the other session that owns the rename. (½ day)
5. Slides block: parser in `public/app.js` (`renderMarkdown` splits at `## Slides`), slide cards CSS from `design-system/MASTER.md`, export panels in `src/export.js`. (½ day)
6. Agents page: file text read-only, overlay fields editable, "Reset knowledge" button. (¼ day)
7. Live run on the Korea example, all three rounds, and compare against the last live transcript. (½ day)

Roughly 3½ to 4 days.

## 7. Verification (each must be able to fail)

- Manifest: add a fourth dummy agent with `enabled: true`; assert it appears in the "To:" list, filter chips, Round 1 grid, and exports; set `enabled: false` and assert it vanishes from all four.
- Persona text: assert the system prompt is byte-identical in structure regardless of `{{COUNTRY}}` value (only the substituted placeholder differs); assert the agent's first Round 1 answer names the actual regulator/HTA body for whatever country was set, sourced.
- CV sources: script opens every URL in the three `cv.md` files and asserts HTTP 200 and that the page text contains the organisation name on that line. Run it against one deliberately wrong URL first.
- Name collision: log the search queries and results for each name in the cv.md header.
- Slides: assert every agent message in a live Round 1 ends with a `## Slides` block of 2 to 4 slides and that the front end rendered the same number of `.slide` cards; export the DOCX and assert the slide titles appear.
- Stance: run the same custom instruction at level 1 and level 5 on one agent; assert the level-5 response contains at least one `⚠ DISAGREEMENT` or "kill" line and the level-1 response contains none. Weak test, but it can fail.
- Non-employee framing: grep live responses for "our company", "we at SLA", "my colleagues at SLA"; assert zero hits.

## 8. Decisions (user, 2026-09-05)

1. Names: keep the three proposed.
2. Regulatory persona is a current ministry official, off the record.
3. (Superseded 2026-09-05 — see decision below.) Country-pack idea dropped entirely: the agent stack is country-agnostic, `{{COUNTRY}}` comes from the session, and every country-specific fact is found by search each turn, not pre-baked.
4. Slides reuse: yes. Interim report per-function section is built from each agent's latest Slides block.
5. No disclosure line. Internal tool.
