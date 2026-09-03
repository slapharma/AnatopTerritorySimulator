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
  FALLBACK_MODELS: ['nvidia/nemotron-3-super-120b-a12b:free', 'nvidia/nemotron-3-ultra-550b-a55b:free'],
  REASONING_EFFORT: 'medium',   // low | medium | high (models that support it)

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

  SEARCH: {
    provider: process.env.BRAVE_API_KEY ? 'brave' : 'duckduckgo',
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
  PORT: Number(process.env.PORT) || 3000,
};
