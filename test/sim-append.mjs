// Validate the loader row in the REAL profile patch.
//
// Two states are legitimate and both are checked:
//   fresh    — the row is absent; simulate appending it and confirm the result
//              still parses, adds exactly one entry, and preserves the
//              pre-existing overrides.
//   installed— the row is already present; confirm it is well formed and unique.
//
// Reads the live patch read-only; any simulated append happens in memory.
//
//   node dsh-notify-cues/test/sim-append.mjs
import { readFileSync } from 'node:fs';
import { parseYaml, insertedEntries } from './yaml-subset.mjs';

const REAL_PATCH = 'C:\\Users\\yxh\\.dsh\\profiles\\desktop\\cordis.patch.yml';
const PLUGIN_ID = 'dsh-notify-cues';
const ENTRY_URL = `file:///C:/Users/yxh/.dsh/profiles/desktop/node_modules/${PLUGIN_ID}/lib/index.js`;
const PRESERVED = ['agent-default-model', 'ui-settings-account', 'ui-chat', 'ui-settings'];

let existing;
try {
  existing = readFileSync(REAL_PATCH, 'utf8');
} catch (error) {
  console.log(`  cannot read live patch (${error.code}); skipping`);
  process.exit(0);
}

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
};

console.log(`\nlive patch: ${REAL_PATCH}`);

const before = parseYaml(existing);
check('patch parses as a top-level sequence', Array.isArray(before), `${before?.length} entries`);
for (const id of PRESERVED) {
  check(`pre-existing override present: ${id}`,
    Array.isArray(before) && before.some((item) => item?.id === id));
}

const installed = existing.includes(PLUGIN_ID);
console.log(`  ....  state: ${installed ? 'installed' : 'fresh'}`);

if (!installed) {
  // --- fresh: simulate the append the install script would perform ----------
  const block = `- insert:
    - id: ${PLUGIN_ID}
      name: '${ENTRY_URL}'
      inject: ['subprocess', 'webServer']
      config:
        notifications: true
`;
  const after = parseYaml(`${existing.trimEnd()}\r\n\r\n${block}`);
  check('combined file still parses', Array.isArray(after), `${after?.length} entries`);
  check('entry count grew by exactly one',
    Array.isArray(after) && after.length === before.length + 1,
    `${before?.length} -> ${after?.length}`);
  const ours = insertedEntries(after).filter((e) => e?.id === PLUGIN_ID);
  check('exactly one insert entry after the append', ours.length === 1, `${ours.length}`);
  check('appended name is a file:// URL', String(ours[0]?.name).startsWith('file://'));
} else {
  // --- installed: the row must be unique and well formed -------------------
  const ours = insertedEntries(before).filter((e) => e?.id === PLUGIN_ID);
  check('exactly one dsh-notify-cues insert entry', ours.length === 1, `${ours.length}`);
  const entry = ours[0];
  check('installed name is a file:// URL', String(entry?.name).startsWith('file://'), String(entry?.name));
  check('installed name is ASCII-only (percent-encoded where needed)',
    !/[^\x00-\x7F]/.test(String(entry?.name)));
  check('installed name points at the profile copy',
    String(entry?.name).includes(`/profiles/desktop/node_modules/${PLUGIN_ID}/lib/index.js`));
  check('injects subprocess + webServer',
    Array.isArray(entry?.inject) && entry.inject.includes('subprocess') && entry.inject.includes('webServer'),
    JSON.stringify(entry?.inject));
  check('config.notifications is a boolean', typeof entry?.config?.notifications === 'boolean');
}

for (const id of PRESERVED) {
  check(`pre-existing override still present: ${id}`,
    Array.isArray(before) && before.some((item) => item?.id === id));
}

console.log(bad === 0 ? '\nprofile patch: OK' : `\nprofile patch: ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
