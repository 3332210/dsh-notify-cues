// Structural check for the Cordis patch files.
//
// They are YAML, but the workspace has no YAML parser and PowerShell 5.1 lacks
// ConvertFrom-Yaml, so this validates the shape against a purpose-built subset
// parser (test/yaml-subset.mjs) using the rules the loader cares about.
import { readFileSync } from 'node:fs';
import { parseYaml } from './yaml-subset.mjs';

let bad = 0;
for (const file of process.argv.slice(2)) {
  console.log(`\n${file}`);
  let doc;
  try {
    doc = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    console.log(`  FAIL  parse error: ${error.message}`);
    bad++;
    continue;
  }

  const check = (label, ok, detail) => {
    if (!ok) bad++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  };

  check('top level is a sequence', Array.isArray(doc), Array.isArray(doc) ? `${doc.length} entries` : typeof doc);
  const first = Array.isArray(doc) ? doc[0] : undefined;
  check('first entry has insert', first !== undefined && 'insert' in first);
  const inserted = first?.insert;
  check('insert is a sequence', Array.isArray(inserted), Array.isArray(inserted) ? `${inserted.length} entries` : typeof inserted);
  const entry = Array.isArray(inserted) ? inserted[0] : undefined;
  check('entry has id', entry?.id === 'dsh-notify-cues', String(entry?.id));
  check('entry has a name', typeof entry?.name === 'string' && entry.name.length > 0, entry?.name);
  check('inject lists subprocess + webServer',
    Array.isArray(entry?.inject) && entry.inject.includes('subprocess') && entry.inject.includes('webServer'),
    JSON.stringify(entry?.inject));
  check('config.notifications is a boolean',
    typeof entry?.config?.notifications === 'boolean', String(entry?.config?.notifications));

  // cordis.patch.yml must be mountable as a package; dev.patch.yml must point
  // at a file:// URL, because the loader calls a bare import(name).
  const isDev = /dev\.patch\.yml$/.test(file);
  if (isDev) {
    check('name is a file:// URL', String(entry?.name).startsWith('file://'), String(entry?.name));
    check('name points at lib/index.js', String(entry?.name).endsWith('/lib/index.js'));
    check('non-ASCII path segment is percent-encoded', !/[^\x00-\x7F]/.test(String(entry?.name)));
  } else {
    check('name is the bare package name', entry?.name === 'dsh-notify-cues', String(entry?.name));
  }
}

console.log(bad === 0 ? '\npatch shape: OK' : `\npatch shape: ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
