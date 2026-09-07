'use strict';
// Model and pricing live here. The app talks to OpenRouter (OpenAI-compatible API).
// Free NVIDIA models cost nothing per token; OpenRouter reports the actual cost of
// every request in its usage block and that figure is what the app records.
module.exports = {
  OPENROUTER_BASE: 'https://openrouter.ai/api/v1',
  // Primary model. 4B active params (26B total MoE), served first-party by Google
  // plus 8 other providers on OpenRouter — good tool-call streaming reliability.
  // Change to any OpenRouter model id.
  // (nemotron-3.5-lightning was tried as a faster swap but its streamed tool_calls
  // deltas don't parse correctly here — turns finish empty with finish_reason
  // "tool_calls" and zero parsed calls. Do not re-add it without fixing that first.)
  MODEL: 'google/gemma-4-26b-a4b-it:free',
  // Tried in order if the primary is rate-limited or down.
  // Nvidia models removed from this list: their free-tier capacity has repeatedly
  // returned "Upstream error from Nvidia: Service temporarily overloaded" mid-stream
  // when OpenRouter auto-routed here, even with a different primary model. Minimax
  // is served by multiple providers including Groq, which has held up better.
  FALLBACK_MODELS: ['minimax/minimax-m2.7:free'],
  REASONING_EFFORT: 'medium',   // low | medium | high (models that support it)

  // Offered in the New Evaluation form's model picker. The model is chosen once,
  // when the session is created, and stored on the session (sessions.model);
  // leaving the picker alone uses MODEL above. Paid options are here for running
  // without free-tier rate limits — they cost real money per OpenRouter's
  // reported usage.cost, shown in the Cost tab as normal.
  // `free: false` gates a model to admins only (src/app.js modelRefusal)
  // — otherwise any authenticated user could start a session on a paid model
  // and run up real OpenRouter spend with no budget check anywhere.
  MODEL_OPTIONS: [
    { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B A4B (free)', free: true },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra 550B (free)', free: true },
    // Far and away the most expensive option here — one full evaluation is
    // dozens of turns, each carrying the whole transcript plus fetched page
    // text, so this is pounds per session, not pence. It is also the only
    // model in the list that reliably reads pages when asked and keeps its
    // evidence tags honest, so it is the one to reach for when a run has to
    // stand up. AUTOPILOT.max_cost_usd still caps a single autopilot run.
    { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5 (paid, ~$2/$10 per M tok — best quality, most expensive)', free: false },
    { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (paid, ~$0.03/$0.13 per M tok)', free: false },
    { id: 'qwen/qwen3.7-flash', label: 'Qwen 3.7 Flash (paid, ~$0.03/$0.13 per M tok)', free: false },
    { id: 'mistralai/mistral-nemo', label: 'Mistral Nemo (paid, cheapest — ~$0.02/$0.03 per M tok)', free: false },
  ],

  // Used only when OpenRouter does not return a cost (it normally does). USD per million tokens.
  PRICES: {
    input_per_mtok: 0,
    output_per_mtok: 0,
    web_search_per_1000: 0,      // DuckDuckGo is free; Brave free tier is free
  },
  USD_TO_GBP: 0.78,              // on-screen GBP estimate only

  MAX_TOKENS_AGENT: 4500,        // compact default; see COMPACT_SUFFIX in prompts.js
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

  // Report depth (3 stops, both Interim and Final). max_tokens scaled per stop;
  // word bands are enforced in the prompt text (prompts/report-*.md).
  REPORT_DEPTH: {
    brief:    { max_tokens: 2000,  words: [0, 450] },
    standard: { max_tokens: 6000,  words: [1000, 1800] },
    full:     { max_tokens: 32000, words: [2500, 4000] }, // = MAX_TOKENS_DECISION
  },

  SEARCH: {
    // DuckDuckGo (the no-key default) scrapes html.duckduckgo.com, which blocks
    // Vercel's datacenter IPs with HTTP 403 — every search fails in production.
    // Tavily is free (1000 req/month, no card) and a real API, not a scrape target.
    provider: process.env.TAVILY_API_KEY ? 'tavily' : process.env.BRAVE_API_KEY ? 'brave' : 'duckduckgo',
    max_results: 8,
    max_searches_per_turn: 12,   // web_search calls one agent may make in a single turn
    max_opens_per_turn: 10,      // open_url calls per turn
    max_tool_rounds: 12,         // model <-> tool exchanges per turn before we stop (kept under Vercel's 800s function cap)
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
