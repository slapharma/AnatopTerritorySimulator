'use strict';
// Finding the passage on a source page that an agent's sentence is talking
// about. The agent quotes nothing verbatim, so this is a best-effort match:
// score every window of the page's text against the claim's rarer words and
// return the best one, or nothing at all when no window scores well enough.
// Saying "we could not find it" is better than highlighting a passage that
// happens to share the word "the".

// Words that carry no signal for matching. Deliberately short: an aggressive
// stop list throws away exactly the domain words ("approval", "reimbursement")
// that make a match trustworthy.
const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'had', 'has', 'have',
  'in', 'is', 'it', 'its', 'not', 'of', 'on', 'or', 'that', 'the', 'their', 'there', 'these', 'they',
  'this', 'to', 'was', 'were', 'which', 'will', 'with', 'would', 'can', 'could', 'may', 'might', 'also',
  'about', 'into', 'than', 'then', 'when', 'where', 'while', 'each', 'per', 'via', 'over', 'under',
]);

const WORD = /[\p{L}\p{N}][\p{L}\p{N}%.,'’/-]*/gu;

function normalise(word) {
  return word.toLowerCase().replace(/^[.,'’/-]+|[.,'’/-]+$/g, '');
}

// Tokens with their character offsets, so a matched window can be mapped back
// to a span of the original text rather than to a rebuilt approximation.
function tokenise(text) {
  const out = [];
  for (const m of String(text).matchAll(WORD)) {
    const word = normalise(m[0]);
    if (word) out.push({ word, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function claimTerms(claim) {
  const counts = new Map();
  for (const t of tokenise(claim)) {
    if (STOP.has(t.word) || t.word.length < 3) continue;
    counts.set(t.word, (counts.get(t.word) || 0) + 1);
  }
  return counts;
}

// A term's worth is how rare it is on this page: a number or a regulator's
// name that appears twice is strong evidence, a word appearing 200 times is
// noise. Terms absent from the page score nothing, which is what lets the
// threshold below reject a page that simply does not discuss the claim.
function termWeights(terms, pageCounts, pageTokenCount) {
  const weights = new Map();
  for (const [term] of terms) {
    const seen = pageCounts.get(term) || 0;
    if (!seen) continue;
    // Digits are the most discriminating thing an agent can carry over from a
    // source ("40%", "2024", "180 days"), so they get a deliberate boost.
    const numeric = /\d/.test(term) ? 1.6 : 1;
    weights.set(term, numeric * Math.log(1 + pageTokenCount / (seen * 12)));
  }
  return weights;
}

/**
 * Locate the passage in `text` that best matches `claim`.
 *
 * Returns { start, end, score, quoted } in character offsets into `text`, or
 * null when nothing clears the threshold. `quoted` is true when the claim
 * contained a quoted phrase that was found verbatim — the only case where the
 * match is certain rather than inferred.
 */
function findPassage(text, claim, { windowWords = 55 } = {}) {
  if (!text || !claim) return null;

  // An exact quote beats any scoring. Agents are asked to quote sparingly, but
  // when they do, that string is the answer and guessing around it would be
  // perverse.
  for (const m of String(claim).matchAll(/[“"]([^”"]{12,240})[”"]/g)) {
    const phrase = m[1].trim();
    const at = text.toLowerCase().indexOf(phrase.toLowerCase());
    if (at !== -1) return { start: at, end: at + phrase.length, score: 1, quoted: true };
  }

  const terms = claimTerms(claim);
  if (!terms.size) return null;

  const tokens = tokenise(text);
  if (tokens.length < 5) return null;

  const pageCounts = new Map();
  for (const t of tokens) pageCounts.set(t.word, (pageCounts.get(t.word) || 0) + 1);
  const weights = termWeights(terms, pageCounts, tokens.length);
  if (!weights.size) return null;

  // The denominator counts the claim's terms that are NOT on the page as well,
  // priced as if they appeared once. Without that, a claim about something else
  // entirely that happens to share two words with the page scores 100% on those
  // two words and gets highlighted. What we want to know is how much of the
  // claim this page accounts for, not how much of the overlap the overlap is.
  const presentTotal = [...weights.values()].reduce((a, b) => a + b, 0);
  let missingTotal = 0;
  for (const [term] of terms) {
    if (weights.has(term)) continue;
    missingTotal += (/\d/.test(term) ? 1.6 : 1) * Math.log(1 + tokens.length / 12);
  }
  const total = presentTotal + missingTotal;

  // Score by sentence, not by a fixed word window. A window straddles the gap
  // between two paragraphs and then highlights half of each — on a procedures
  // page that means marking the 210-day rule when the agent was talking about
  // the 120-day one, which is worse than not highlighting at all. A sentence is
  // also the unit a reader checks a claim against.
  const sentences = splitSentences(text);
  if (!sentences.length) return null;

  const covered = sentences.map((sen) => {
    const seen = new Set();
    let sum = 0;
    for (const t of tokenise(text.slice(sen.start, sen.end))) {
      const w = weights.get(t.word);
      if (w && !seen.has(t.word)) { seen.add(t.word); sum += w; }
    }
    return { sum, words: seen };
  });

  // A claim can straddle two sentences ("...takes 120 days. Fees are 45,000."),
  // so runs of up to three are considered, with each extra sentence having to
  // earn its place — otherwise the whole paragraph always wins.
  let pick = null;
  for (let i = 0; i < sentences.length; i++) {
    const seen = new Set();
    let sum = 0;
    for (let j = i; j < Math.min(sentences.length, i + 3); j++) {
      for (const w of covered[j].words) if (!seen.has(w)) { seen.add(w); sum += weights.get(w); }
      const value = sum - 0.12 * total * (j - i);
      if (!pick || value > pick.value) pick = { from: i, to: j, value, sum };
    }
  }
  if (!pick) return null;

  // How much of the claim this passage accounts for. Measured against a page of
  // procedures, real matches score 0.42–1.00 (an agent rewords, so it is never
  // 1.0 in practice) and claims that merely share a word or two score 0.09–0.16;
  // 0.35 sits in that gap. Erring high costs a highlight the reader could have
  // used, erring low points at a sentence the agent never read.
  const ratio = total > 0 ? pick.sum / total : 0;
  if (ratio < 0.35) return null;

  return { start: sentences[pick.from].start, end: sentences[pick.to].end, score: ratio, quoted: false };
}

// Sentence spans, with paragraph breaks treated as boundaries too: scraped
// pages run headings and list items together with no terminating full stop, so
// splitting on punctuation alone would glue a heading to the paragraph below it.
function splitSentences(text) {
  const out = [];
  let start = 0;
  const re = /([.!?…]["'’”)]*\s+|\n+)/g;
  for (const m of text.matchAll(re)) {
    const end = m.index + m[0].length;
    if (text.slice(start, end).trim()) out.push({ start, end: m.index + m[0].trimEnd().length });
    start = end;
  }
  if (text.slice(start).trim()) out.push({ start, end: text.length });
  return out;
}

// The surrounding text the highlight sits in. The match is already a whole
// sentence, so this reaches for the sentences either side of it — the earliest
// boundary in the lead and the latest in the tail, so a whole neighbouring
// sentence comes along rather than the punctuation that ends the match.
function withContext(text, span, { before = 320, after = 320 } = {}) {
  const startFloor = Math.max(0, span.start - before);
  const endCeil = Math.min(text.length, span.end + after);
  const lead = text.slice(startFloor, span.start);
  const tail = text.slice(span.end, endCeil);
  const boundaries = (s) => [...s.matchAll(/[.!?…]\s+|\n+/g)].map((m) => m.index + m[0].length);
  const leadCuts = boundaries(lead);
  const tailCuts = boundaries(tail);
  // Falling back to a word boundary, with an ellipsis, keeps the excerpt from
  // opening or closing mid-word when the page has no punctuation to cut on.
  const beforeText = leadCuts.length ? lead.slice(leadCuts[0])
    : (startFloor > 0 ? `…${lead.replace(/^\S*\s/, '')}` : lead);
  const afterText = tailCuts.length ? tail.slice(0, tailCuts[tailCuts.length - 1])
    : (endCeil < text.length ? `${tail.replace(/\s\S*$/, '')}…` : tail);
  return {
    before: beforeText.trim(),
    match: text.slice(span.start, span.end).trim(),
    after: afterText.trim(),
  };
}

module.exports = { findPassage, withContext, tokenise };
