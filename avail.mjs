// Submits your standing weekly RSO availability to TeamWork (tmwork.net).
//
// Reads the desired week from config.json and the password from the macOS
// Keychain -- no credentials live in this folder.
//
//   node avail.mjs            show what would change, submit nothing
//   node avail.mjs --submit   actually save it
//   node avail.mjs --force    submit even when nothing differs
//
// Dry run is the default on purpose: this writes to a real scheduling system
// your managers read, so submitting is always an explicit choice.

import { readFileSync } from 'node:fs';
import { DAY_ORDER, connect, loadTemplate, applyWeek, saveAndVerify } from './tmwork.mjs';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));
const submit = process.argv.includes('--submit');
const force = process.argv.includes('--force');

const session = await connect(config);
console.log('signed in');

const { meta, template } = await loadTemplate(session, config);
const changes = applyWeek(template, config.week);

console.log(`\ntemplate: ${meta.Title} (id ${meta.Id})`);
for (const day of template.Days) {
  const name = DAY_ORDER[day.DayIndex - 1];
  const mark = changes.some((c) => c.name === name) ? ' <-- changed' : '';
  console.log(`  ${name.padEnd(10)} ${day.Enabled ? 'all-day' : 'off'}${mark}`);
}

if (!changes.length && !force) {
  console.log('\nAlready matches config, nothing to submit.');
  process.exit(0);
}

if (!submit) {
  console.log(`\n${changes.length} change(s) pending. Re-run with --submit to save.`);
  process.exit(0);
}

// Closed loop: save, then re-read from TeamWork and confirm it really took.
const result = await saveAndVerify(session, config, config.week);

if (result.mismatches.length) {
  console.error('\nSaved, but TeamWork does not agree:');
  for (const m of result.mismatches) {
    console.error(`  ${m.day.padEnd(10)} wanted ${m.wanted}, got ${m.actual}`);
  }
  process.exit(1);
}

console.log('\nsaved and verified');
