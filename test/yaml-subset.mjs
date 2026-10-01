// Minimal parser for the YAML subset the Cordis patch files use: block
// sequences, `key: value` maps, inline arrays, single-quoted scalars, and
// full-line comments. Shared by patch-shape.mjs and sim-append.mjs.
//
// Exists because neither the workspace nor PowerShell 5.1 ships a YAML parser.

/** Parse the used YAML subset into JS values. */
export function parseYaml(text) {
  const lines = text
    .split(/\r?\n/)
    .map((raw) => raw.replace(/\t/g, '  '))
    .filter((raw) => raw.trim() !== '' && !raw.trim().startsWith('#'))
    .map((raw) => ({ indent: raw.length - raw.trimStart().length, text: raw.trim() }));

  let index = 0;

  const scalar = (raw) => {
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1).trim();
      if (inner === '') return [];
      return inner.split(',').map((s) => scalar(s.trim()));
    }
    if (/^'.*'$/.test(raw) || /^".*"$/.test(raw)) return raw.slice(1, -1);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^-?\d+$/.test(raw)) return Number(raw);
    return raw;
  };

  const parseBlock = (indent) => {
    if (index >= lines.length) return null;
    if (lines[index].text.startsWith('- ') || lines[index].text === '-') {
      const items = [];
      while (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith('-')) {
        const rest = lines[index].text.replace(/^-\s*/, '');
        if (rest === '') {
          index++;
          items.push(parseBlock(lines[index]?.indent ?? indent + 2));
        } else if (/^[^:]+:/.test(rest)) {
          // Inline first key of a map whose siblings follow on later lines.
          lines[index] = { indent: indent + 2, text: rest };
          items.push(parseBlock(indent + 2));
        } else {
          items.push(scalar(rest));
          index++;
        }
      }
      return items;
    }
    const map = {};
    while (index < lines.length && lines[index].indent === indent && !lines[index].text.startsWith('-')) {
      const current = lines[index].text;
      const colon = current.indexOf(':');
      if (colon < 0) throw new Error(`line ${index + 1}: expected "key: value", got "${current}"`);
      const key = current.slice(0, colon).trim();
      const rest = current.slice(colon + 1).trim();
      index++;
      if (rest === '') {
        const next = lines[index];
        map[key] = next && next.indent > indent ? parseBlock(next.indent) : null;
      } else {
        map[key] = scalar(rest);
      }
    }
    return map;
  };

  return parseBlock(lines[0]?.indent ?? 0);
}

/** Collect the `config.notifications`-style insert entries in a patch list. */
export function insertedEntries(doc) {
  const found = [];
  if (!Array.isArray(doc)) return found;
  for (const item of doc) {
    if (item === null || typeof item !== 'object' || !Array.isArray(item.insert)) continue;
    for (const entry of item.insert) found.push(entry);
  }
  return found;
}
