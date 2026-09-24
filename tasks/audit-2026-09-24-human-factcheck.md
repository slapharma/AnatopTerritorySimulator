# Audit 2026-09-24: human perspective and fact-checking

Scope, as asked: does the simulator work, does the conversation make sense, can the moderator
find what they need to decide, and do the agents' fact-checking policies stop hallucination.

## How this was tested

- **Unit suite:** 611 of 611 tests pass (`node --test test/*.test.js`, no database).
- **Two full evaluations.** A scratch harness ran the app's own `prompts.js`, `agents.runTurn`,
  `open_url`, `transcript.assembleText` and disagreement/question parsers against an **in-memory
  database**. No production data was read or written.
  - Inputs: the Korea example (`BASE_VALUES`), with reference approvals, target launch and
    competitor file left blank as the example leaves them.
  - Sequence: Baselines in parallel, then Challenge and Converge one agent at a time. Minutes and
    the answered-check ran after each meeting, then a Final report.
  - Run 1 used the **default model, Mistral Nemo**. Run 2 used **Qwen 3.7 Flash**, which is already
    in the model list (admin-only).
  - Full transcripts are kept locally, not in the repo (it is public and they contain commercial analysis); rerun with `scripts/simulate-session.js` to reproduce.
- **Every cited URL was probed.** Six claims that survived as VERIFIED were re-opened through the
  app's own `open_url`, to check that the page says what the agent claimed.
- **Code review** of the server flow (`src/`) and the moderator UI (`web/`), by two read-only
  agents, with file:line references checked.
- **Not done:** reading real production transcripts. Read-only database access was blocked by
  this session's permission policy (see "Open question" at the end). The UI was reviewed from its
  code, not clicked through with live data.
- **Cost of the runs:** about $0.002 on Nemo and $0.03 on Qwen, plus roughly 60 Tavily searches.

## Verdict

1. **On the default model the simulator does not work as an evidence tool.**
   - Across all 9 agent turns, Mistral Nemo made **zero web searches and opened zero pages**.
   - Every "source" it cited was made up from memory. Of the 17 URLs cited:
     - 10 return 404 and 2 fail to load.
     - 1 is an MFDS "page not found" screen served with HTTP 200.
     - 2 sit behind Cochrane's cookie wall.
     - 1 is the homepage of a different society (cancer prevention, not coloproctology).
     - The only real document is the ICH E10 PDF, and it is cited for a trial that does not exist.
   - The Final report still recommends **GO WITH CONDITIONS, confidence Medium**. It reports
     **"VERIFIED: 12"** when nothing in the session was verified.
   - This has been the default for every user since commit `45b6926` on 2026-09-22.
2. **On a model that uses its tools, the meeting makes sense.**
   - With Qwen, the agents searched (in Korean too), read real pages, challenged and conceded
     by name, revised figures (Charlie moved the P&L after Ruth's evidence), and logged one
     well-formed disagreement.
   - A pharma reader would recognise it as a working meeting.
3. **Even then, unsupported claims still reach the decision-maker.** There are four leaks:
   - A VERIFIED badge means only that a page was opened, not that the page says what was claimed.
   - Claims the app itself downgraded get restated as fact, by other agents and by the minutes.
   - The minutes and the report's evidence table are never checked.
   - The personas are told to invent professional anecdotes.
4. **The moderator cannot see evidence quality.**
   - There are no VERIFIED / ESTIMATE / UNKNOWN counts anywhere.
   - A downgraded tag looks like any other amber estimate.
   - Invented URLs appear in Sources with the same green "cited" pill as pages that were read.
   - The minutes that are emailed after each meeting drop every tag.

## Findings

### A. The default model does no research (P0)

| | Mistral Nemo (default) | Qwen 3.7 Flash |
|---|---|---|
| Searches / pages opened, Baselines | 0/0, 0/0, 0/0 | 8/2, 7/2, 4/4 |
| Searches / pages opened, Challenge | 0/0 for all three | 5/4, 5/4, 8/3 |
| Cited URLs never searched or opened | 17 of 17 | 2 of 12 |
| Disagreements logged | 0 (format not followed) | 1, well-formed |
| Slides blocks | none | 7 of 9 turns |
| Final report, Standard depth | written, but wrong (see below) | **failed**: "ran out of output tokens before writing anything" |
| Cost, whole session | $0.002 | $0.03 |

Nemo, in its own words, from the transcript:

- **Invented MFDS pages** with sequential ids: `mfds.go.kr/eng/pb/pb01020101.do` through
  `pb01020104.do`, all 404. It also cites an EMA "EPAR for Anatop", which is 404.
- **Wrong drugs.**
  - "Nifedipine (Rectiv, Perforomist)": Rectiv is nitroglycerin, and Perforomist is formoterol,
    an inhaled COPD treatment.
  - Charlie lists "Nifedipine (Rectogesic, Anbrosia)": Rectogesic is glyceryl trinitrate.
- **An invented pivotal trial.** "The Phase III trial in the Inputs … uses a relevant comparator
  (GTN)". The Inputs contain no trial at all (see finding E).
- **Numbers that do not add up.**
  - Cost to approval is "₩15 million" (about £8k) in every Round 3 table.
  - A ₩200,000 price per tube is set against competitors priced at ₩15,000.
  - Luca and Charlie pasted Ruth's Round 3 table almost verbatim, so "convergence" was copying.
- **Research handed to the human.** All 6 questions logged are addressed to the Moderator and
  ask them to do the research, e.g. "Can you confirm the current prevalence of chronic anal
  fissure in South Korea?".

**Why the guard did not fire:**
- `src/agents.js:268` only pushes an agent to open pages when `counters.searches > 0`. A turn
  that never searches passes straight through.
- `transcript.js` then downgrades each VERIFIED tag. The claim text, the invented URL and its
  `[n]` citation all stay.

**The Qwen report failure** is a separate bug. Standard depth allows 6,000 output tokens
(`src/config.js:89`). The model returned no text at all, most likely because it spent that
budget reasoning (`REASONING_EFFORT: 'medium'`). At Full depth (32,000 tokens) the same report
succeeded. Brief allows only 2,000 tokens and is likely to fail the same way. Standard is the
dialog's default.

### B. What a VERIFIED badge proves (P0)

The only check is that some URL in the tag was opened in the same turn
(`src/transcript.js:40`). Nothing compares the claim with the page. Spot check of Qwen's
surviving VERIFIED tags, re-opened through the app's own `open_url`:

| Claim | Page | Supported? |
|---|---|---|
| MFDS new-drug fee about KRW 410m, was about 8.83m; 295-day target | intoinworld.com (a consultancy blog) | Yes. But it is a secondary source, and not labelled as one (evidence rule 1). |
| New route of administration makes it IMD or new drug | mfds.go.kr approval-process page | Yes |
| MOHW reform of 26 March 2026; expedited listing for rare disease first | shinkim.com newsletter | Yes |
| Linkage pilot "limited to" Qarziba and Bylvay | pharmaceutical-technology.com, **2024** | Partly. The article says the first two eligible; the agent wrote "currently limited to" in 2026. |
| "I have reviewed the MFDS framework updates and ICH E5 application in South Korea" | ddregpharma.com "When are bridging studies mandatory under ICH E5" | **No.** The text the agent received never mentions MFDS or Korea. |
| "Post-hoc comparison against Wang et al. 2025 confirms comparable healing with superior tolerability" (about DAF-09) | PMC12175783, a network meta-analysis of anal-fissure drugs | **Misattributed.** Europe PMC confirms the title and abstract: 22 published RCTs, comparing diltiazem, GTN, nifedipine and others. It cannot "confirm" a post-hoc analysis of DAF-09, an internal report the agent never read. |

So even with a good model, **about one VERIFIED badge in three** in this sample is not what the
page says. The app shows all of them as equally green.

Two further bugs make the badge less accurate in both directions:

- **Genuine evidence demoted.** `openedUrls` is per turn (`transcript.js:20-24`).
  - Round 3 restates Round 1-2 evidence without re-opening it, so every restated VERIFIED is
    shown as "unverified, downgraded". Seen: Ruth's intoinworld tag, Charlie's shinkim tag.
  - The Final report is checked against the Moderator Assistant's own turn
    (`src/app.js:868`), so all three VERIFIED tags it carried forward were demoted.
  - This contradicts the guide's "keeping their tags and disagreements intact"
    (`web/guide.html:170`).
- **Redirects and scheme changes demote real opens.**
  - The trace records the post-redirect URL (`src/search.js:271`, `src/agents.js:159`), but
    agents are told to cite the URL they requested.
  - The report cited `http://www.hitnews.co.kr/…` for a page it had opened as `https://…`.
  - Matching is exact-string.

### C. Unverified claims leak into minutes, reports and Sources (P0)

- **The minutes drop every tag and invent content** (`src/app.js:1040` stores `result.text`
  raw; the minutes are emailed automatically).
  - Nemo's minutes state "The statutory review clock is 240 days" and "Surgery is common, with
    around 50% of cases requiring it within a year" as plain fact. Both were unsourced.
  - Nemo's minutes also say "Open disagreements: None" after two challenges ending "Status:
    UNRESOLVED".
  - Qwen's Round 3 minutes say the fee rise was "effective January 1, 2025". **That date
    appears in no transcript message**; the minutes writer made it up.
  - Qwen's minutes also present Luca's disputed position ("The dossier can legally be filed as
    stand-alone …") as a finding, despite the open disagreement on exactly that point.
- **Downgraded claims turn into consensus.**
  - Charlie named an "NIFDS Gastroenterology & Metabolism Products Division", citing a URL on
    a domain that does not exist (`pacificbridgemedial.com`), so it was downgraded.
  - Ruth and Luca then repeated it untagged in Round 3, and wrote it into the disagreement's
    "what would settle it" line.
  - The minutes state it as fact. The Final report builds a next action on it: "Request a
    formal advisory meeting with the Gastroenterology & Metabolism Products Division".
  - Evidence rule 4, "repetition is not evidence", is not enforced anywhere.
- **The Final report's evidence table is never checked.** Its URLs sit in table cells, not tags,
  so no downgrade applies (`transcript.js:48-68`). In the Qwen report's "Evidence checked"
  table:
  - 2 of 6 rows cite pages nobody opened (asiae.co.kr, ddregpharma MFDS page). The DDReg one
    had already been downgraded in the transcript.
  - 1 row credits DAF-09 results to the Wang meta-analysis.
  - Nemo's report counted 12 VERIFIED items when there were none.
- **Invented URLs become "cited" sources.** Every URL inside a tag, downgraded or not, and every
  bare URL is registered as kind `cited` (`transcript.js:28, 44, 64`). It gets a number, a green
  "cited" pill in Sources and a row in the export's Verification section (`src/export.js:230`).
  All 17 of Nemo's invented URLs are listed as cited sources.

### D. The personas are told to invent experience (P1)

- All three persona files tell the agent to "refer back to your own past reviews / trial
  experience / deal experience when relevant", with examples such as "the last topical fissure
  product I reviewed hit exactly this question…" (`regulatory/persona.md:12`,
  `clinical/persona.md:10`, `commercial/persona.md:10`).
- Ruth is also an insider who can "be candid about how your agency actually behaves"
  (`regulatory/persona.md:5`).
- These are fictional people, so every such anecdote is an invented precedent. It cannot be
  tagged, and it reads as expert testimony.
- It happened in the Qwen run:
  - "Based on what I've seen in similar dossiers: (1) incomplete bridging justification …"
  - "MFDS reviewers have historically liked Korean PK data even when global sponsors argue it
    is unnecessary" (untagged).
- The CVs say the experience is illustrative, but the persona instructions invite the model to
  present it as fact.

### E. The questions ask about inputs the form no longer collects (P1)

- Luca's standing question is "Will the pivotal data **in the Inputs** (population, comparator,
  endpoints) satisfy local KOLs…" (`clinical/questions.md:4`).
- The "Dossier on hand" and "Manufacturing" fields were removed in `efc407a` (2026-09-07), so
  there is no pivotal data in the Inputs. Ruth's GMP question has no manufacturing site to
  reason about either.
- The knowledgebase gives only the title of the DAF-09 study report, which the agents cannot
  open. The result is invention:
  - Nemo invents a GTN-controlled Phase III.
  - Qwen asserts "DAF-09 delivers robust healing and pain endpoints versus placebo" (untagged).
- Relatedly, the knowledgebase instruction says "cite them by title … do not invent their
  content" (`src/prompts.js:238`), but there is no tag for "internal document, not read", so a
  figure attributed to DAF-09 looks like any other claim.

### F. What the moderator cannot see (P1)

From the UI review (`web/app.js`, `web/index.html`, `web/guide.html`):

- **No evidence-quality summary.** Nothing counts VERIFIED / ESTIMATE / UNKNOWN / downgraded
  tags per message, agent or session, or shows how many pages were opened. The open count is
  stored per message (`agents.js:229`) but never displayed.
- **A downgraded tag looks like any other amber ESTIMATE** (`web/app.js:159-162`). The word
  "downgraded" appears only inside the pill's small text.
- **Sources makes no difference between "opened and read" and "a URL an agent typed".**
- **The guide overstates the badge.** It defines VERIFIED as "checked against a real source,
  with a link" (`web/guide.html:100`). It never mentions downgrading, truncation, or that a badge
  proves a page was opened, not that it agrees.
- **Questions for the moderator are easy to miss.** There is no "for you" filter or count.
  The automatic answered-check can mark them answered from another agent's message
  (`src/app.js:684`). A block headed "Questions for the Moderator (human):", which the prompt's
  own wording invites, is silently dropped (`src/questions.js:13, 24, 72`).
- **The decision is not on the main screen.**
  - It lives only on the Decision & reports page.
  - "Decided" on the evaluations list just means a Final report exists, even an INSUFFICIENT
    INFORMATION one.
  - Nothing marks it stale after later meetings or input edits.
- **Truncated answers look finished.** The truncation marker is plain bold text at the end of a
  collapsed message, the meeting step still turns green, and the marker is usually hidden.
- **Missing inputs are hidden.** INPUT MISSING items show only on the Inputs page, which is last
  in the sidebar. Input edits leave no trace in the transcript.

### G. Robustness bugs found on the way (P2)

- **Long sessions lose Round 1 in reports.** Reports and minutes see the transcript through the
  same 60,000-character window, dropping the oldest messages first (`src/prompts.js:290-305`).
  Round 1 baselines, which hold the core facts, are the first to go. Reports get no source list
  or tool traces, only transcript text.
- **The moderator's system prompt conflicts with the report prompts.**
  - `prompts/moderator.md` (the 11-section decision template, 2,500–4,000 words) is the system
    prompt for every Moderator Assistant call, including Brief reports (450 words), minutes and
    the JSON answered-check.
  - The evidence rules add "end every response with a Slides block" to all of them. Nemo's
    Standard report followed the decision template and ended with slides.
  - `report-final.md` has no Confidence line and no "points of disagreement" section;
    `moderator.md` has both.
- **Disagreement capture depends on exact wording** (`src/app.js:474`). The block must contain
  the word "DISAGREEMENT", the Status line must be upper case, and so on. Nemo's
  "⚠ **Local data requirement** (Status: UNRESOLVED)" was not logged.
- **Regenerating a message can delete a disagreement.** Disagreements and questions cascade on
  message delete (`sql/schema.sql:95, 225`), and a restatement re-points the row to the newest
  message. Regenerating that message then deletes the disagreement, including the moderator's
  status.
- **The moderator's resolved/unresolved toggle is overwritten by the next agent that restates the
  block** (`src/db.js:331`).
- **Malformed tags lose their badge.** Tags missing the closing bracket (`[UNKNOWN |`) or in
  mixed case (`[Verified — …]`) are neither badged nor checked (`TAG_RE` is case-sensitive).

## Fact-checking policy review

| Rule (`prompts/evidence-rules.md`) | Enforced? | Gap |
|---|---|---|
| 1. Search before asserting | **No.** The nudge only fires after at least one search. | A model that never searches is never challenged (finding A) |
| 1. Secondary sources must be labelled and under 3 years old | Dates are extracted; the label is not required | Blogs carry VERIFIED badges identical to regulator pages |
| 2. Tag every factual claim | **No.** Nothing detects untagged claims. | 1–5 untagged figure lines per turn even on Qwen |
| 2. VERIFIED needs a full URL, and the page opened | Yes, per turn | Proves an open, not support (B); demotes genuine repeats (B) |
| 3. Numbers as ranges, local currency plus GBP | No | Qwen used USD throughout; exchange rates come from memory |
| 4. Repetition is not evidence | No | Downgraded claims become consensus and minute "facts" (C) |
| 5. No splitting the difference | Prompt only | Not observed in these runs |
| 8. INPUT MISSING must not be invented | Prompt only | Violated by both models on pivotal data (E) |
| Tools: a snippet justifies at most ESTIMATE | Yes (downgrade) | The URL is still listed as a cited source (C) |
| Page text is untrusted | Yes (wrapper, open_url limited to URLs from search results, private-IP block) | Fine |
| Blocked, cookie-wall or 203 pages cannot verify | Yes | PDFs are always blocked, so most regulator PDFs can never be VERIFIED |
| Minutes and reports keep the tags | **No** (minutes are unchecked; reports use a per-turn check) | Minutes invent and drop tags (C) |
| Personas: stay factual | **The opposite.** They are told to cite personal experience | Invented anecdotes (D) |

## Recommended fixes, in priority order

**Batch 1: stop the hallucination paths (code, P0)**

1. **Default model.** Move off Mistral Nemo to a model that calls tools. Qwen 3.7 Flash
   measured about $0.03 per full session; Claude Sonnet 5 is the quality ceiling. The model
   list flags would need to follow.
2. **No research, no pass.** For Baselines, Challenge, reply and custom turns, a turn with zero
   searches is refused once ("search before asserting"), in the same way as the existing
   read-nudge. If the retry still does not search, the message carries a visible "no research
   this turn" flag.
3. **One opened-URL set per session.** VERIFIED checks accept a URL opened by any agent earlier
   in the session. This fixes the Round 3 and report demotions. Record both the requested and
   the final URL of every open, and compare URLs normalised (scheme, trailing slash, fragment).
4. **Sources get a third kind.** A URL that was never searched or opened is stored as
   `unverified`, not `cited`, and shown that way in Sources and the exports.
5. **Minutes keep tags and only restate the transcript.** Either the prompt requires every
   figure to carry its original tag, or the minutes are assembled from each agent's own Slides
   block, with Open disagreements taken from the database log rather than written by a model.
6. **The evidence table is built by the app, not the model.** Every tag in the session, with
   speaker, round, whether the URL was opened, and whether it was downgraded, goes into the
   report as data and is rendered as-is.
7. **Report token budgets.** Raise the Brief and Standard `max_tokens` so a reasoning model can
   finish. The ceiling costs nothing unless it is used.

**Batch 2: make VERIFIED mean "the page says so" (policy plus code, P0/P1)**

8. **Quote-anchored VERIFIED.** The tag carries a short verbatim quote from the page:
   `[VERIFIED — source, URL, date, "exact words"]`.
   - The server checks the quote against the text that `open_url` returned. Store it per open.
   - A missing or unmatched quote is downgraded with the reason shown.
   - This catches the DDReg-style unsupported badge mechanically, and it gives the moderator the
     evidence inline.
9. **Persona edits.** Remove "refer back to your own past reviews/cases/deals" and the insider
   "how your agency actually behaves" line. Allow experience only as labelled professional
   judgement, e.g. `[ESTIMATE — professional judgement, not a sourced case]`.
10. **Internal documents.** Add an `[INTERNAL — <title>, not read by the agent]` tag or rule.
    Restore a short **Pivotal evidence** input (population, comparator, endpoints, headline
    result). Otherwise, reword Luca's question to treat the data as INPUT MISSING.
11. **Secondary-source label.** Require `secondary` inside the VERIFIED tag for law-firm,
    consultancy and blog pages, and badge it differently.

**Batch 3: put the evidence in front of the moderator (UI, P1)**

12. **Evidence strip.** On each message: searches, pages opened, and VERIFIED / downgraded /
    ESTIMATE / UNKNOWN counts. The same strip per agent and per session on the Decision tab.
13. **Distinct badges.** Downgraded tags get their own style (e.g. amber with a strikethrough
    "VERIFIED" and the reason). Sources marks opened, searched and unverified separately.
14. **Questions for the Moderator.** A "for you" count and filter, excluded from the automatic
    answered-check, and "(human)" parsed.
15. **Decision banner** on the transcript, showing the recommendation, confidence and date,
    with a "stale" flag if meetings ran after it. Truncated messages get a visible warning and
    leave the meeting amber.
16. **Guide.** State what VERIFIED does and does not prove, explain downgrades and the
    cited/opened/unverified labels, and correct the "tags intact" line.

**Also:**
- Fix the disagreement regex tolerance, the cascade on regenerate, and the overwrite of the
  moderator's toggle.
- Give reports a larger or smarter transcript window: pin Round 1–3 and drop autopilot chatter
  first.
- Split `moderator.md` so the decision template is used only for decision and report turns.

## Open question

The production database would show whether real evaluations since 22 September on the default
model have the same zero-search pattern. Reading it needs a read-only permission this session
does not have. The harness forces read-only at the connection level, so any write fails at the
server.
