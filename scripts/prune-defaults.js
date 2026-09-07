// Removes stored form defaults whose field no longer exists in
// prompts.INPUT_FIELDS. Deleting a field from the form leaves its saved value
// behind in app_defaults.values_json, where nothing reads it and the PATCH
// route refuses to touch it (unknown key -> 400), so it can only be cleared
// from outside the app.
//
//   node scripts/prune-defaults.js            # report only, writes nothing
//   node scripts/prune-defaults.js --apply    # rewrite the row without them
//   node scripts/prune-defaults.js --apply --clear <key>   # also blank a live field
//
// Talks to whatever DATABASE_URL points at, which is production.
'use strict';
require('../src/bootstrap');
const db = require('../src/db');
const prompts = require('../src/prompts');

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const clear = args.includes('--clear') ? args[args.indexOf('--clear') + 1] : null;

  const valid = new Set(prompts.INPUT_FIELDS.map((f) => f.key));
  const current = await db.getDefaults();
  const dead = Object.keys(current).filter((k) => !valid.has(k));

  console.log(`app_defaults holds ${Object.keys(current).length} key(s); ${dead.length} no longer have a field.`);
  for (const k of dead) console.log(`  dead  ${k} = ${JSON.stringify(current[k])}`);
  if (clear) {
    if (!valid.has(clear)) throw new Error(`--clear ${clear} is not a current field`);
    console.log(`  clear ${clear} = ${JSON.stringify(current[clear])}`);
  }
  if (!dead.length && !clear) return console.log('Nothing to do.');
  if (!apply) return console.log('\nDry run. Re-run with --apply to write.');

  const next = {};
  for (const [k, v] of Object.entries(current)) if (valid.has(k) && k !== clear) next[k] = v;
  await db.replaceDefaults(next);

  const after = await db.getDefaults();
  const leftover = Object.keys(after).filter((k) => !valid.has(k));
  if (leftover.length) throw new Error(`Prune did not take: ${leftover.join(', ')} still stored`);
  if (clear && clear in after) throw new Error(`${clear} is still stored`);
  console.log(`\nDone. ${Object.keys(after).length} key(s) remain: ${Object.keys(after).sort().join(', ')}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
