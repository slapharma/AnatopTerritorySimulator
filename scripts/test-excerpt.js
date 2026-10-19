// Checks for the source-passage matcher behind the source preview modal.
// Run with `npm run test:excerpt`. Each case is written so it can fail:
// slackening the threshold in src/excerpt.js turns the last two red.
const { findPassage, withContext } = require('../src/excerpt');
let fails = 0;
const check = (name, fn) => { let r; try { r = fn(); } catch (e) { r = 'threw ' + e.message; } if (r !== true) { fails++; console.log('FAIL', name, '->', r); } else console.log('pass', name); };

const page = [
  'Ministry of Health of Anatop — Marketing authorisation procedures.',
  'Applications are reviewed by the National Medicines Agency. The standard national procedure takes 210 days from validation to decision, excluding clock stops.',
  'An abridged procedure is available for products already approved in a reference country, and takes 120 days.',
  'Fees for a new chemical entity are set at 45,000 units. Renewals are due every five years.',
  'Contact the agency for guidance on pricing and reimbursement, which is handled separately by the National Health Fund.',
].join('\n');

check('finds the 210-day passage', () => {
  const span = findPassage(page, 'The national procedure in Anatop runs to 210 days from validation, excluding clock stops [1].');
  if (!span) return 'no match';
  const got = page.slice(span.start, span.end);
  return got.includes('210 days') ? true : 'matched: ' + got;
});

check('finds the abridged 120-day passage, not the 210 one', () => {
  const span = findPassage(page, 'An abridged route exists for products approved in a reference country, at 120 days.');
  if (!span) return 'no match';
  const got = page.slice(span.start, span.end);
  return got.includes('120 days') && !got.includes('210 days') ? true : 'matched: ' + got;
});

check('exact quote wins and is flagged', () => {
  const span = findPassage(page, 'The page states: "Renewals are due every five years" for all holders.');
  if (!span) return 'no match';
  return span.quoted === true && page.slice(span.start, span.end) === 'Renewals are due every five years' ? true : JSON.stringify(span);
});

check('unrelated claim matches nothing', () => {
  const span = findPassage(page, 'Paediatric cardiology outcomes improved after the 2019 surgical guideline was adopted in Norway.');
  return span === null ? true : 'matched: ' + page.slice(span.start, span.end);
});

check('empty claim matches nothing', () => findPassage(page, '') === null ? true : 'matched something');
check('empty page matches nothing', () => findPassage('', 'anything at all here') === null ? true : 'matched something');

check('context wraps the match with surrounding sentence', () => {
  const span = findPassage(page, '210 days from validation to decision');
  const ctx = withContext(page, span);
  return ctx.match.includes('210 days') && (ctx.before + ctx.after).length > 0 ? true : JSON.stringify(ctx);
});

// Negative control: break the matcher's own weighting and prove the tests go red.
check('CONTROL: a claim of stopwords only must not match', () => {
  const span = findPassage(page, 'the and of to in is for by with that this a an are');
  return span === null ? true : 'matched: ' + page.slice(span.start, span.end);
});


check('a claim only glancingly related to the page matches nothing', () => {
  const span = findPassage(page, 'The national football agency in Anatop plays five matches each winter against neighbouring clubs.');
  return span === null ? true : 'matched: ' + page.slice(span.start, span.end);
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
