# Claude Code prompt — Launch Working-Group web app

**Before you paste this:** create an empty folder (e.g. `C:\Projects\launch-workinggroup`), copy `Anatop_Launch_WorkingGroup_Prompt_v2.md` into it, open Claude Code in that folder, then paste everything below the line.

---

Build me a local web app called **Launch Working Group**. I am a beginner developer on Windows using PowerShell, so explain each step in plain English, keep the stack simple, and make it run with one command. Ask me clarifying questions before you start if anything below is ambiguous.

## What the app does
It simulates a cross-functional working group evaluating a pharmaceutical product launch in a target country. Three AI agents (Regulatory, Clinical, Commercial) discuss the launch. I am the moderator. The full spec for the agents, their questions, the evidence rules, and the input fields is in `Anatop_Launch_WorkingGroup_Prompt_v2.md` in this folder — read it first and treat it as the source of truth for agent behaviour.

## User flow
1. **New session** — a form with every field from Section 0 of the spec (product, indication, country, regulator, reference approvals, dossier on hand, manufacturing, commercial targets, partner status, exclusions, budget ceiling, decision deadline, competitor notes). Include a "Load Korea example" button that pre-fills the Anatop / South Korea values from the spec. Blank fields are allowed but must be passed to the agents as INPUT MISSING.
2. **Opening round** — on submit, each agent responds in turn (Regulatory, then Clinical, then Commercial), each seeing the inputs and the previous agents' responses. Stream the text as it arrives so I am not staring at a blank screen.
3. **Live discussion** — I can then type a message and address it to one agent or all agents. Agents can also ask me or each other questions and challenge each other. Add a button "Let the agents respond to each other" that runs one round of cross-talk without me typing. The conversation continues until I end it.
4. **Decision output** — a button "Write the decision output" makes a Moderator-assistant produce Section 4 of the spec (recommendation, pathway, risks, kill criteria, unresolved items, verification appendix, next 5 actions) from the whole transcript.
5. **Save, reopen, export** — sessions autosave. A sidebar lists saved sessions with title, country, and date; any can be reopened and continued. Export any session as **Word (.docx)** and **PDF**.

## Agent behaviour (non-negotiable)
- Each agent has its own system prompt built from the spec: persona, its list of questions, and the full evidence rules from Section 1.
- Agents **must use live web search** for any claim about the target country's regulation, fees, timelines, reimbursement, standard of care or competitors, and cite the URL. Use the Anthropic Messages API with the built-in web search tool.
- Every factual claim is tagged `[VERIFIED — source, URL, date]`, `[ESTIMATE — basis]` or `[UNKNOWN — needs in-market expert]`. Render these as coloured badges in the UI (green / amber / grey).
- Agents may end a message with a "Questions for:" block naming me or another agent; render these prominently so I can answer them.
- Agents only disagree where the evidence or incentives differ — no manufactured conflict. When they do disagree, the message should include a `⚠ DISAGREEMENT` marker; collect these into a "Disagreement log" panel with status Resolved / Unresolved that I can toggle.
- Agents see the full transcript so far, labelled by speaker, every time they respond.

## Sources
- Every URL from a web search result or citation is captured automatically into a **Sources panel** for the session: numbered, deduplicated, with title, URL, date first cited, and which agent/message cited it.
- In the transcript, citations show as numbered links `[3]` that jump to the source.
- Sources are stored with the session and included as an appendix in every export.

## Exports
- **Word (.docx)** using the `docx` npm package, font **Montserrat** throughout. Structure: title page (product, country, date), Inputs table, transcript with speaker headings and the tag badges rendered as coloured text, Disagreement log, Decision output (if written), Sources appendix.
- **PDF** with the same structure and Montserrat (embed the font; download Montserrat from Google Fonts into the project). Use whichever library you judge most reliable on Windows — suggest before choosing.
- On screen, the transcript should read like a well-formatted meeting record: clear speaker colour per agent, timestamps, collapsible long messages, and the same Montserrat font.

## Technical constraints
- Stack: Node.js + Express backend, plain HTML/CSS/JavaScript frontend (no framework build step), SQLite for storage via `better-sqlite3`. If you think a different stack is clearly better for a beginner on Windows, say why and let me choose.
- The Anthropic API key lives in a `.env` file and is only ever used server-side. Never expose it to the browser. Create `.env.example` and tell me exactly how to get a key and where to paste it.
- Model: use the latest Claude Sonnet model available; put the model name in one config constant so I can change it.
- Show me a running cost estimate per session in the UI (tokens used × price), read from a config file I can update.
- Handle errors visibly: if a search or API call fails, show what failed and a retry button — never silently drop an agent's turn.
- One command to start: `npm start`, then open `http://localhost:3000`. Give me the exact PowerShell commands to install and run.

## How I want you to work
1. First, read the spec file and summarise back to me in five bullets what you'll build, plus any questions. Wait for my go-ahead.
2. Build in stages and tell me when each is testable: (a) setup form + opening round, (b) live discussion + agent cross-talk, (c) save/reopen + sources panel, (d) decision output, (e) exports.
3. After each stage, give me a two-line "how to test this" instruction.
4. Write a short `README.md` in plain English: what the app is, how to run it, how to change the agents' prompts, and how to adapt it for another country.
