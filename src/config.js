'use strict';
// Model and pricing live here. The app talks to OpenRouter (OpenAI-compatible API).
// Free NVIDIA models cost nothing per token; OpenRouter reports the actual cost of
// every request in its usage block and that figure is what the app records.
module.exports = {
  OPENROUTER_BASE: 'https://openrouter.ai/api/v1',
  // Primary model. Qwen 3.7 Flash since 2026-09-24. Mistral Nemo, the default
  // from 2026-09-22 (chosen to get off the free tier's 429s), never called its
  // tools: in a measured Korea evaluation it ran nine turns with zero searches
  // and cited 17 URLs it had invented (tasks/audit-2026-09-24-human-factcheck.md).
  // Qwen searched and read in the same run, in Korean as well as English, for
  // about $0.03 a session. Paid, so no free-tier rate cap. Change to any
  // OpenRouter model id, but check it calls web_search first: a model that
  // answers from memory looks fine until the sources are opened.
  // (nemotron-3.5-lightning was tried as a faster swap but its streamed tool_calls
  // deltas don't parse correctly here — turns finish empty with finish_reason
  // "tool_calls" and zero parsed calls. Do not re-add it without fixing that first.)
  MODEL: 'qwen/qwen3.7-flash',
  // Tried in order if the primary is rate-limited or down.
  // Nvidia models removed from this list: their free-tier capacity has repeatedly
  // returned "Upstream error from Nvidia: Service temporarily overloaded" mid-stream
  // when OpenRouter auto-routed here, even with a different primary model. Minimax
  // is served by multiple providers including Groq, which has held up better.
  // Kept as a last-resort free fallback even though the primary is now paid —
  // if Mistral Nemo itself is down, a free model finishing the turn beats none.
  FALLBACK_MODELS: ['minimax/minimax-m2.7:free'],
  REASONING_EFFORT: 'medium',   // low | medium | high (models that support it)

  // Offered in the New Evaluation form's model picker and the session header's.
  // The choice is stored on the session (sessions.model) and can be switched
  // between meetings, each switch noted in the transcript; leaving the picker
  // alone uses MODEL above. Paid options are here for running
  // without free-tier rate limits — they cost real money per OpenRouter's
  // reported usage.cost, shown in the Cost tab as normal.
  // `free: false` gates a model to admins only (src/app.js modelRefusal)
  // — otherwise any authenticated user could start a session on a paid model
  // and run up real OpenRouter spend with no budget check anywhere.
  MODEL_OPTIONS: [
    // free:true here (not gated) because MODEL above defaults every session to
    // this model already — refusing an explicit pick of the same model a
    // non-admin already got by default would be inconsistent, not safer.
    { id: 'qwen/qwen3.7-flash', label: 'Qwen 3.7 Flash (default — ~$0.03/$0.13 per M tok)', free: true },
    { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B A4B (free, rate-limited ~20 req/min)', free: true },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra 550B (free)', free: true },
    // Far and away the most expensive option here — one full evaluation is
    // dozens of turns, each carrying the whole transcript plus fetched page
    // text, so this is pounds per session, not pence. It is also the only
    // model in the list that reliably reads pages when asked and keeps its
    // evidence tags honest, so it is the one to reach for when a run has to
    // stand up. AUTOPILOT.max_cost_usd still caps a single autopilot run.
    { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5 (paid, ~$2/$10 per M tok — best quality, most expensive)', free: false },
    { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (paid, ~$0.03/$0.13 per M tok)', free: false },
  ],

  // Models taken out of service because they cannot do the job, with the reason
  // written into the transcript when a session still on one is moved off it.
  // A session keeps whatever model it was created with (sessions.model), so
  // without this every evaluation started on Nemo would go on answering from
  // memory. The next turn in such a session switches it to MODEL, and the
  // switch note says why.
  RETIRED_MODELS: {
    'mistralai/mistral-nemo': 'it does not use web search, so its answers came from memory with invented sources',
  },

  // Used only when OpenRouter does not return a cost (it normally does). USD per million tokens.
  PRICES: {
    input_per_mtok: 0,
    output_per_mtok: 0,
    web_search_per_1000: 0,      // DuckDuckGo is free; Brave free tier is free
  },
  USD_TO_GBP: 0.78,              // on-screen GBP estimate only

  // Ceilings, not targets: a request is billed for what it writes. A reasoning
  // model spends part of this thinking before any visible text, so a tight
  // ceiling ends a turn with nothing written (finish_reason "length").
  MAX_TOKENS_AGENT: 8000,        // compact default; see COMPACT_SUFFIX in prompts.js
  MAX_TOKENS_DIVE_DEEPER: 16000, // "Dive Deeper" follow-up on one response
  MAX_TOKENS_DECISION: 32000,

  // Autopilot response-length slider (5 stops). "as_required" reuses the
  // Dive Deeper budget and appends no length sentence to the instruction.
  // The instruction's "Hard limit: N characters" line is what actually holds
  // the model to length — max_tokens here is only a generous safety ceiling,
  // not sized tightly to N: reasoning tokens (REASONING_EFFORT) and tool-call
  // rounds eat into the same budget before any visible text is written, so a
  // tight ceiling starves the model and the turn fails with an empty response
  // (finish_reason "length", zero text) before it gets to write anything.
  AUTOPILOT_CHAR_STOPS: [300, 600, 1200, 2500, 'as_required'],
  AUTOPILOT_CHAR_TO_TOKENS: { 300: 3000, 600: 3500, 1200: 4500, 2500: 6000 },

  AUTOPILOT: {
    max_cycles: 30,       // hard safety cap even when interactions = infinity
    max_cost_usd: 2,      // hard safety cap for one run's summed message cost_usd
    default_max_chars: 600,
  },

  // Report depth (3 stops, both Interim and Final). Word bands are enforced in
  // the prompt text (prompts/report-*.md); max_tokens only has to leave room
  // for them after the model's reasoning. At 6000, a Standard Final report on
  // Qwen 3.7 Flash spent the whole budget reasoning and wrote nothing
  // (2026-09-24); the same report at 32000 wrote 18k characters.
  REPORT_DEPTH: {
    brief:    { max_tokens: 8000,  words: [0, 450] },
    standard: { max_tokens: 16000, words: [1000, 1800] },
    full:     { max_tokens: 32000, words: [2500, 4000] }, // = MAX_TOKENS_DECISION
  },

  SEARCH: {
    // DuckDuckGo (the no-key default) scrapes html.duckduckgo.com, which blocks
    // Vercel's datacenter IPs with HTTP 403 — every search fails in production.
    // Tavily is free (1000 req/month, no card) and a real API, not a scrape target.
    provider: process.env.TAVILY_API_KEY ? 'tavily' : process.env.BRAVE_API_KEY ? 'brave' : 'duckduckgo',
    max_results: 8,
    // These three are one budget, not three independent caps, and the previous
    // values made reading impossible. Searches and rounds were both 12, and the
    // model issues one search per round, so it exhausted the round budget on
    // search alone and never reached open_url: measured across a live Round 1,
    // regulatory did 12 searches and 1 open, clinical 11 and 1, commercial 11
    // and 0. max_opens_per_turn: 10 was unreachable. Since a snippet only ever
    // justifies ESTIMATE, every VERIFIED tag in that run was correctly demoted
    // by transcript.js — the whole evidence layer was snippet-deep.
    //
    // Searches and opens now sum to the round budget, so an agent that uses its
    // full search allowance still has an equal number of rounds left to read
    // what it found. Raising rounds costs wall-clock: turns ran 180-280s at 12
    // rounds, and each open adds a page fetch plus its text to the context, so
    // this stays well inside TURN_TIMEOUT_MS and Vercel's 800s function cap.
    max_searches_per_turn: 8,    // web_search calls one agent may make in a single turn
    max_opens_per_turn: 8,       // open_url calls per turn
    max_tool_rounds: 16,         // model <-> tool exchanges per turn before we stop
    page_chars: 8000,            // characters of page text returned by open_url
    timeout_ms: 15000,
  },

  // Free models on OpenRouter are rate-limited (roughly 20 requests/min; a daily cap that is
  // higher once the account holds $10 of credit). Each tool exchange is one request.
  RETRY_ON_429: 4,
  // A turn that hits this stops itself with a clear, catchable error instead of
  // running until Vercel's 800s function cap kills it with no explanation and
  // the message row stuck looking "in progress" forever.
  TURN_TIMEOUT_MS: 750000,
  PORT: Number(process.env.PORT) || 3000,
};
