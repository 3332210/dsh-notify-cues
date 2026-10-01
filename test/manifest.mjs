// Validate package.json's DSH manifest against the INSTALLED harness.
//
// This exists because a `dsh.client.inject` entry naming a package that does not
// exist is accepted by the harness validator (it only type-checks the array) and
// then never resolves at load time. A real plugin in this ecosystem ships
// exactly that bug, and it silently stops the browser half from loading.
//
// The archive location is machine-specific, so override it when needed:
//   DSH_ASAR=/path/to/app.asar node test/manifest.mjs package.json
//
// Exits 0 with a "skipped" note when no harness install is present, so a fork or
// a CI runner without the harness still builds green.
import { readFileSync, openSync, closeSync, readSync } from 'node:fs';

const ASAR = process.env.DSH_ASAR ?? 'D:\\software\\DeepSeek Harness\\resources\\app.asar';

/** Every scoped package name shipped in an app.asar. */
function shippedPackages(asarPath) {
  const fd = openSync(asarPath, 'r');
  try {
    // openSync/readSync rather than readFileSync: the archive is hundreds of MB
    // and only the header is needed.
    const sizeBuf = Buffer.alloc(8);
    readSync(fd, sizeBuf, 0, 8, 0);
    const headerSize = sizeBuf.readUInt32LE(4);
    const hb = Buffer.alloc(headerSize);
    readSync(fd, hb, 0, headerSize, 8);
    const header = JSON.parse(hb.subarray(hb.indexOf(0x7b)).toString('utf8'));
    const names = new Set();
    (function walk(node, prefix) {
      for (const [name, value] of Object.entries(node.files ?? {})) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (value.files) walk(value, path);
        else {
          const match = /node_modules\/@deepseek-ai\/([^/]+)\//.exec(path);
          if (match) names.add(`@deepseek-ai/${match[1]}`);
        }
      }
    })(header, '');
    return names;
  } finally {
    closeSync(fd);
  }
}

const pkg = JSON.parse(readFileSync(process.argv[2] ?? 'package.json', 'utf8'));
let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
};

console.log(`\nmanifest: ${pkg.name}`);

// --- packaging -------------------------------------------------------------
check('name is a bare package name', /^[a-z0-9][a-z0-9-]*$/.test(pkg.name), pkg.name);
check('version present', typeof pkg.version === 'string' && pkg.version.length > 0, pkg.version);
check('type is module', pkg.type === 'module', String(pkg.type));
check('exports["./client"] declared for the browser half',
  typeof pkg.exports?.['./client'] === 'string' || typeof pkg.exports?.['./client']?.default === 'string',
  JSON.stringify(pkg.exports?.['./client']));

// --- dsh.bundle ------------------------------------------------------------
check('dsh.bundle.patch declared', typeof pkg.dsh?.bundle?.patch === 'string', String(pkg.dsh?.bundle?.patch));

// --- dsh.client ------------------------------------------------------------
const client = pkg.dsh?.client;
check('dsh.client declared', client !== undefined && typeof client === 'object');
check('dsh.client.platform === "web"', client?.platform === 'web', String(client?.platform));
// The harness validator accepts exactly these four keys.
const allowed = new Set(['platform', 'inject', 'external', 'immediately']);
const extra = Object.keys(client ?? {}).filter((k) => !allowed.has(k));
check('dsh.client has no unknown keys', extra.length === 0, extra.length ? extra.join(', ') : 'none');

// --- the real check: does every injected package exist? --------------------
let shipped;
try {
  shipped = shippedPackages(ASAR);
} catch (error) {
  console.log(`  ....  harness not found at ${ASAR} (${error.code ?? error.name})`);
  console.log('  ....  set DSH_ASAR to the app.asar path to run the existence check');
  console.log(bad === 0 ? '\nmanifest: OK (existence check skipped)' : `\nmanifest: ${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

const injected = client?.inject ?? [];
console.log(`  ....  harness ships ${shipped.size} @deepseek-ai packages; plugin injects ${injected.length}`);
for (const name of injected) {
  check(`injected package exists: ${name}`, shipped.has(name),
    shipped.has(name) ? 'found' : 'NOT SHIPPED — the browser half may never load');
}
if (injected.length === 0) {
  console.log('  OK    no dsh.client.inject entries — fine for a slots-only plugin (the renderer is immediate)');
}

console.log(bad === 0 ? '\nmanifest: OK' : `\nmanifest: ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
