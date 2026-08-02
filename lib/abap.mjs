/*
 * abap — shared ABAP source parsing primitives.
 *
 * Extracted from abap2UI5/ai-demokit scripts/render-smoke.mjs (the corpus
 * render gate), unchanged in behaviour: comment scrubbing and string-aware
 * region/statement splitting for backtick literals and |...| templates.
 */

/* Remove comments so tokens in comments are never parsed. Comment text is
 * replaced by BLANKS, not dropped: every character keeps its position, so a
 * match index in the scrubbed source is a valid offset into the original
 * file — that is what lets findings carry a line and column. */
export function scrub(abap) {
  return abap.split('\n').map((line) => {
    if (/^\*/.test(line)) return ' '.repeat(line.length);
    let out = '';
    let str = null; // '`' | '|' when inside a literal/template
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (str === '`') {
        out += c;
        if (c === '`') str = null; // doubled backticks re-enter immediately — harmless
        continue;
      }
      if (str === '|') {
        out += c;
        if (c === '\\') { out += line[++i] ?? ''; continue; }
        if (c === '|') str = null;
        continue;
      }
      if (c === '`' || c === '|') { str = c; out += c; continue; }
      if (c === '"') { out += ' '.repeat(line.length - i); break; } // comment till end of line
      out += c;
    }
    return out;
  }).join('\n');
}

// balanced-paren region starting at content[open] === '(' — string-aware
export function parenRegion(content, open) {
  let depth = 0;
  let str = null;
  for (let i = open; i < content.length; i++) {
    const c = content[i];
    if (str === '`') { if (c === '`') str = null; continue; }
    if (str === '|') {
      if (c === '\\') { i++; continue; }
      if (c === '|') str = null;
      continue;
    }
    if (c === '`' || c === '|') { str = c; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return { body: content.slice(open + 1, i), end: i };
  }
  return { body: content.slice(open + 1), end: content.length };
}

// split a region on a top-level separator (paren- and string-aware)
export function topSplit(region, sep) {
  const parts = [];
  let depth = 0;
  let str = null;
  let start = 0;
  for (let i = 0; i < region.length; i++) {
    const c = region[i];
    if (str === '`') { if (c === '`') str = null; continue; }
    if (str === '|') {
      if (c === '\\') { i++; continue; }
      if (c === '|') str = null;
      continue;
    }
    if (c === '`' || c === '|') { str = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && region.startsWith(sep, i)) {
      parts.push(region.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(region.slice(start));
  return parts;
}

/* Split an ABAP method body into statements, string- and paren-aware (the
 * terminator '.' inside `…`/|…| strings or ( ) is not a split point). Each
 * statement carries its offset in `src` so findings can be traced back to a
 * line in the file. */
export function splitStatements(src) {
  const out = [];
  let depth = 0, str = null, start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (str === '`') { if (c === '`') str = null; continue; }
    if (str === '|') { if (c === '\\') { i++; continue; } if (c === '|') str = null; continue; }
    if (c === '`' || c === '|') { str = c; continue; }
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '.' && depth === 0) { out.push({ text: src.slice(start, i), offset: start }); start = i + 1; }
  }
  if (src.slice(start).trim()) out.push({ text: src.slice(start), offset: start });
  return out;
}

// parse `name = value  name2 = value2` into { name: value }, string- and
// paren-aware so a `=` inside a `…` value is not a boundary
export function parseNamedArgs(argBody) {
  const marks = [];
  let depth = 0, str = null, i = 0;
  while (i < argBody.length) {
    const c = argBody[i];
    if (str) {
      if (str === '`' && c === '`') str = null;
      else if (str === '|') { if (c === '\\') { i += 2; continue; } if (c === '|') str = null; }
      i++; continue;
    }
    if (c === '`' || c === '|') { str = c; i++; continue; }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') { depth--; i++; continue; }
    if (depth === 0 && (i === 0 || /\s/.test(argBody[i - 1]))) {
      const mm = argBody.slice(i).match(/^(\w+)\s*=\s*/);
      if (mm) { marks.push({ name: mm[1], nameStart: i, vstart: i + mm[0].length }); i += mm[0].length; continue; }
    }
    i++;
  }
  const args = {};
  for (let k = 0; k < marks.length; k++) {
    const end = k + 1 < marks.length ? marks[k + 1].nameStart : argBody.length;
    args[marks[k].name] = argBody.slice(marks[k].vstart, end).trim();
  }
  return args;
}
