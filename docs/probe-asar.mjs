// Reliable in-memory search across the packed DSH app.asar.
//
// The adopted docs/asar.cjs mis-computes entry offsets on this archive, so this
// reads every entry with the layout my earlier probes verified:
//   u32 @4 = headerSize (pickle payload size), JSON header follows 4 bytes later,
//   file data starts at 8 + headerSize, entry offsets are relative to that.
//
// Usage: node probe-asar.mjs <regex> [--path=substr] [--ext=.js,.ts] [--max=40] [--ctx=2]
import { openSync, readSync, readFileSync } from 'node:fs';

const ASAR = 'D:\\software\\DeepSeek Harness\\resources\\app.asar';
const UNPACKED = 'D:\\software\\DeepSeek Harness\\resources\\app.asar.unpacked\\';

const args = process.argv.slice(2);
const pattern = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const pathFilter = opt('path', '');
const exts = opt('ext', '.js,.mjs,.cjs,.ts,.json,.md,.yml,.yaml').split(',');
const max = Number(opt('max', 40));
const ctx = Number(opt('ctx', 0));

const fd = openSync(ASAR, 'r');
const sizeBuf = Buffer.alloc(8);
readSync(fd, sizeBuf, 0, 8, 0);
const headerSize = sizeBuf.readUInt32LE(4);
const hb = Buffer.alloc(headerSize);
readSync(fd, hb, 0, headerSize, 8);
const header = JSON.parse(hb.subarray(hb.indexOf(0x7b)).toString('utf8'));
const dataStart = 8 + headerSize;

const entries = [];
(function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (value.files) walk(value, path);
    else entries.push({ path, size: Number(value.size ?? 0), offset: Number(value.offset ?? 0), unpacked: !!value.unpacked });
  }
})(header, '');

const readEntry = (entry) => {
  if (entry.unpacked) return readFileSync(UNPACKED + entry.path.replace(/\//g, '\\'), 'utf8');
  const buf = Buffer.alloc(entry.size);
  readSync(fd, buf, 0, entry.size, dataStart + entry.offset);
  return buf.toString('utf8');
};

const re = new RegExp(pattern, 'g');
let hits = 0;
for (const entry of entries) {
  if (entry.size === 0 || entry.size > 6_000_000) continue;
  if (pathFilter && !entry.path.includes(pathFilter)) continue;
  if (!exts.some((e) => entry.path.endsWith(e))) continue;
  let text;
  try { text = readEntry(entry); } catch { continue; }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (!re.test(lines[i])) continue;
    console.log(`${entry.path}:${i + 1}`);
    const from = Math.max(0, i - ctx);
    const to = Math.min(lines.length, i + ctx + 1);
    for (let j = from; j < to; j++) {
      console.log(`${j === i ? '>' : ' '} ${j + 1}| ${lines[j].trim().slice(0, 240)}`);
    }
    if (++hits >= max) { console.log(`[hit cap ${max}]`); process.exit(0); }
  }
}
console.log(`[hits ${hits}]`);
