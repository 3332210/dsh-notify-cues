// Static contract check for the dsh-notify-cues browser bundle.
// The bundle cannot be imported in Node (it self-registers onto window), so
// validate the required shape textually instead.
import fs from 'node:fs';

const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');

const checks = [
  ['__ModuleLoader__.load wrapper', /window\.__ModuleLoader__\.load\(\{/],
  ['factory(require) shape', /factory:\s*\(require\)\s*=>/],
  ['bundle id matches plugin id', /id:\s*["']dsh-notify-cues["']/],
  ['exports.apply', /exports\.apply\s*=/],
  ['exports.inject', /exports\.inject\s*=/],
  ['react via require', /__require\(["']react["']\)/],
  ['registers into settings.section', /settings\.section/],
  ['declares its own child slot', /dsh-notify-cues\.content/],
  ['declares the child slot as list/root', /kind:\s*["']list["'][\s\S]{0,40}scope:\s*["']root["']/],
  ['navigation label provided', /label:\s*function/],
  ['talks to the host config route', /\/dsh-notify-cues\/config/],
  ['talks to the host presence route', /\/dsh-notify-cues\/presence/],
  ['talks to the host preview route', /\/dsh-notify-cues\/test/],
  ['reports visibility state', /document\.visibilityState/],
  ['reports window focus', /document\.hasFocus\(\)/],
  ['registers a session-scoped presence reporter',
    /slots\.inject\(\s*["']conversation\.session\.header\.utilities["']/],
  ['presence reporter reads the main-view session', /retainedBy[\s\S]{0,40}mainView/],
  ['no JSX (must be plain createElement)', /=>\s*</],
];

let bad = 0;
for (const [name, re] of checks) {
  let ok = re.test(src);
  // The last check is inverted: matching it is a failure.
  if (name.startsWith('no JSX')) ok = !ok;
  if (!ok) bad++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}`);
}
console.log(bad === 0 ? '  -> browser bundle contract satisfied' : `  -> ${bad} check(s) failed`);
process.exit(bad === 0 ? 0 : 1);
