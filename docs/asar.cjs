#!/usr/bin/env node
// Minimal asar reader for DSH plugin-contract inspection.
// Usage:
//   node asar.js ls   <prefix>
//   node asar.js read <entryPath> [startLine] [endLine]
//   node asar.js grep <regex> [--files-only] [--ext .js,.ts] [--path=substr]
//   node asar.js cat  <entryPath>            (raw, no line numbers)
'use strict';
const fs = require('fs');
const path = require('path');

const ASAR = 'D:\\software\\DeepSeek Harness\\resources\\app.asar';
const UNPACKED = ASAR + '.unpacked';

let _header = null;
let _dataStart = 0;

function loadHeader() {
  if (_header) return _header;
  // Verified layout of this archive:
  //   u32 @0  = 4           (pickle size of the following u32)
  //   u32 @4  = headerSize  (size of the header pickle payload)
  //   u32 @8  = headerSize - 4
  //   u32 @12 = jsonLen     (== headerSize - 8)
  //   @16..   = JSON header string (jsonLen bytes)
  //   dataStart = 8 + headerSize
  const fd = fs.openSync(ASAR, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(4);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  fs.closeSync(fd);
  _header = JSON.parse(jsonBuf.toString('utf8'));
  _dataStart = 8 + headerSize;
  return _header;
}

function* walk(node, prefix) {
  const files = node.files || {};
  for (const name of Object.keys(files)) {
    const child = files[name];
    const p = prefix ? prefix + '/' + name : name;
    if (child.files) yield* walk(child, p);
    else yield { path: p, entry: child };
  }
}
function allEntries() { return Array.from(walk(loadHeader(), '')); }

let _fd = null;
function readEntry(p) {
  const found = allEntries().find((x) => x.path === p);
  if (!found) return null;
  const ent = found.entry;
  if (ent.unpacked) return fs.readFileSync(path.join(UNPACKED, p.replace(/\//g, path.sep)));
  if (_fd === null) _fd = fs.openSync(ASAR, 'r');
  const buf = Buffer.alloc(ent.size);
  fs.readSync(_fd, buf, 0, ent.size, _dataStart + Number(ent.offset));
  return buf;
}
function withLines(text, start, end) {
  const lines = text.split(/\r?\n/);
  const from = start ? Math.max(1, start) : 1;
  const to = end ? Math.min(lines.length, end) : lines.length;
  const out = [];
  const w = String(to).length;
  for (let i = from; i <= to; i++) out.push(String(i).padStart(w, ' ') + '| ' + lines[i - 1]);
  return out.join('\n');
}

const [, , cmd, ...rest] = process.argv;
if (cmd === 'ls') {
  const prefix = (rest[0] || '').replace(/\/$/, '');
  const entries = allEntries().filter((e) => !prefix || e.path.startsWith(prefix + '/'));
  if (!prefix) { for (const t of [...new Set(entries.map((e) => e.path.split('/')[0]))].sort()) console.log(t); }
  else {
    for (const e of entries.sort((a, b) => a.path.localeCompare(b.path))) console.log(e.path + (e.entry.unpacked ? '  [unpacked]' : '  (' + e.entry.size + 'b)'));
    console.log('--- total: ' + entries.length);
  }
} else if (cmd === 'read' || cmd === 'cat') {
  const buf = readEntry(rest[0]);
  if (!buf) { console.error('NOT FOUND: ' + rest[0]); process.exit(2); }
  const text = buf.toString('utf8');
  if (cmd === 'cat') console.log(text);
  else {
    const start = rest[1] ? parseInt(rest[1], 10) : 0;
    const end = rest[2] ? parseInt(rest[2], 10) : 0;
    console.log('=== ' + rest[0] + ' (' + buf.length + ' bytes) ===');
    console.log(withLines(text, start, end));
  }
} else if (cmd === 'grep') {
  const re = new RegExp(rest[0], 'g');
  let filesOnly = false, extFilter = null, pathFilter = null, maxFiles = 400;
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] === '--files-only') filesOnly = true;
    else if (rest[i] === '--ext') extFilter = rest[++i].split(',');
    else if (rest[i].startsWith('--path=')) pathFilter = rest[i].slice(7);
    else if (rest[i].startsWith('--max=')) maxFiles = Number(rest[i].slice(6));
  }
  let count = 0;
  for (const e of allEntries()) {
    if (extFilter && !extFilter.some((x) => e.path.endsWith(x))) continue;
    if (pathFilter && !e.path.includes(pathFilter)) continue;
    if (e.entry.size > 12 * 1024 * 1024) continue;
    let text;
    try { text = readEntry(e.path).toString('utf8'); } catch (err) { continue; }
    const lines = text.split(/\r?\n/);
    const hits = [];
    for (let i = 0; i < lines.length; i++) { re.lastIndex = 0; if (re.test(lines[i])) hits.push((i + 1) + ': ' + lines[i].trim().slice(0, 500)); }
    if (hits.length) {
      console.log('### ' + e.path);
      if (!filesOnly) console.log(hits.slice(0, 80).join('\n'));
      if (++count > maxFiles) { console.log('... truncated'); break; }
    }
  }
} else if (cmd === 'ctx') {
  const text = readEntry(rest[0]).toString('utf8');
  const lit = rest[1];
  const before = Number(rest[2] ?? 200), after = Number(rest[3] ?? 1200);
  let idx = -1, n = 0;
  while ((idx = text.indexOf(lit, idx + 1)) !== -1) {
    n++;
    console.log('--- occurrence ' + n + ' at char ' + idx + ' ---');
    console.log(text.slice(Math.max(0, idx - before), idx + after));
    console.log('');
    if (n >= 8) break;
  }
  if (n === 0) console.log('literal not present');
} else if (cmd === 'extract') {
  const outRoot = rest[0];
  const prefixes = rest.slice(1);
  const chosen = allEntries().filter((e) => prefixes.some((p) => e.path === p || e.path.startsWith(p.replace(/\/$/, '') + '/')));
  let n = 0;
  for (const e of chosen) {
    const dest = path.join(outRoot, e.path.replace(/\//g, path.sep));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readEntry(e.path));
    n++;
  }
  console.log('extracted ' + n + ' files to ' + outRoot);
} else {
  console.log('commands: ls | read | cat | grep | ctx | extract');
}
