// Verify that the `name:` value inside a patch YAML is a loadable ESM
// specifier — i.e. that mounting will actually succeed. The Cordis loader
// hands this string to a bare import(), so a plain filesystem path fails with
// ERR_UNSUPPORTED_ESM_URL_SCHEME.
//
// A checkout ships dev.patch.yml with a REPLACE/WITH placeholder, so this
// reports "skipped" rather than failing until the value is filled in.
//
//   node test/patch-loadable.mjs dev.patch.yml
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'dev.patch.yml';
const text = readFileSync(file, 'utf8');
const match = /^\s*name:\s*'([^']+)'/m.exec(text);
if (!match) {
  console.log('  FAIL  no quoted name: entry found');
  process.exit(1);
}
const spec = match[1];
console.log(`  specifier: ${spec}`);

if (spec.includes('REPLACE/WITH')) {
  console.log('  skipped  the name: value is still the placeholder — set it before mounting');
  process.exit(0);
}

try {
  const mod = await import(spec);
  const hasApply = typeof mod.apply === 'function';
  const hasInject = Array.isArray(mod.inject);
  // The official host-plugin contract is `apply` + optional `inject`/`Config`.
  // `export const name` is deliberately NOT part of it: cordis derives a debug
  // name from the JS function name and discards "apply", while plugin identity
  // comes from the Loader entry's `id` in cordis.patch.yml.
  const leaksName = 'name' in mod;
  console.log('  OK    imports cleanly');
  console.log(`  OK    inject = ${JSON.stringify(mod.inject)}`);
  console.log(`  ${hasApply ? 'OK   ' : 'FAIL '} exports apply`);
  console.log(`  ${hasInject ? 'OK   ' : 'FAIL '} exports inject array`);
  console.log(`  ${leaksName ? 'WARN ' : 'OK   '} no stray \`name\` export (not part of the contract)`);
  process.exit(hasApply && hasInject ? 0 : 1);
} catch (error) {
  console.log(`  FAIL  ${error.code ?? error.name}: ${String(error.message).slice(0, 120)}`);
  process.exit(1);
}
