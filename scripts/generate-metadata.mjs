#!/usr/bin/env node
/*
 * Builds data/properties.json — the UI5 metadata snapshot both gates read.
 *
 * Per control: parent class, class-level @since/@deprecated, implemented
 * interfaces, the default aggregation, and every declared member with its
 * type — properties (with their @since and enum/primitive type),
 * aggregations (type + cardinality), associations and events. Plus a
 * global enum table (allowed values per enum type).
 *
 * That is what lets the property gate answer, statically:
 *   does this control exist?                       -> unknown-control
 *   does this property/event/association exist?    -> unknown-property
 *   is this value allowed for that property?       -> invalid-property-value
 *   does this aggregation exist on that control?   -> unknown-aggregation
 *   may this control sit in that aggregation?      -> invalid-aggregation-child
 *
 * Source: the OpenUI5 control sources. Resolved from, in order:
 *   OPENUI5_DIR (a full OpenUI5 checkout: <dir>/src/<lib>/src/<libpath>)
 *   node_modules/@openui5/<lib>/src/<libpath>   (the npm packages)
 * The npm packages ship the same sources, so `npm ci` is enough - no
 * OpenUI5 clone needed.
 *
 * Run:  node scripts/generate-metadata.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'properties.json');

const LIBS = [
  'sap.m', 'sap.f', 'sap.ui.core', 'sap.ui.layout', 'sap.ui.table',
  'sap.ui.unified', 'sap.uxap', 'sap.tnt', 'sap.ui.codeeditor', 'sap.ui.integration',
];

/* Base classes every control inherits from. They live in the sap.ui.core
 * package but outside its library path, and without them every inheritance
 * chain ends in an unknown class - which would make the gate treat every
 * chain as incomplete and never report an unknown member. */
const BASE_DIRS = [['sap/ui/base', 'sap.ui.core']];

/** [libPath, sourceDir] per library, from OPENUI5_DIR or the npm packages. */
function libDirs() {
  const out = [];
  const resolveDir = (pkg, libPath) => {
    const candidates = [];
    if (process.env.OPENUI5_DIR) {
      candidates.push(path.join(process.env.OPENUI5_DIR, 'src', pkg, 'src', ...libPath.split('/')));
    }
    candidates.push(path.join(ROOT, 'node_modules', `@openui5/${pkg}`, 'src', ...libPath.split('/')));
    return candidates.find((c) => fs.existsSync(c));
  };
  for (const lib of LIBS) {
    const libPath = lib.replace(/\./g, '/');
    const dir = resolveDir(lib, libPath);
    if (dir) out.push([libPath, dir]);
    else console.error(`WARNING: no sources for ${lib} - skipped`);
  }
  for (const [libPath, pkg] of BASE_DIRS) {
    const dir = resolveDir(pkg, libPath);
    if (dir) out.push([libPath, dir]);
  }
  return out;
}

function collect(dir, moduleBase, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, `${moduleBase}/${e.name}`, acc);
    else if (e.name.endsWith('.js') && !e.name.endsWith('Renderer.js')) acc.push([p, moduleBase]);
  }
}

const dotted = (p, base) => {
  const abs = p.startsWith('.') ? path.posix.join(base, p) : p;
  return abs.replace(/\//g, '.');
};

/* JSDoc blocks in the UI5 sources are full of braces ({@link ...}, {string}),
 * so any brace matching has to skip comments and string literals - counting
 * raw braces silently collapses the metadata sections into each other. */

/** Index just past a comment/string starting at i, or i when there is none. */
function skipTrivia(src, i) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end < 0 ? src.length : end + 2;
  }
  if (c === '/' && src[i + 1] === '/') {
    const end = src.indexOf('\n', i);
    return end < 0 ? src.length : end + 1;
  }
  if (c === '"' || c === "'" || c === '`') {
    let j = i;
    while (++j < src.length && src[j] !== c) if (src[j] === '\\') j++;
    return j + 1;
  }
  return i;
}

/** Body of the balanced {...} starting at src[open] === '{'. */
function braceBody(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const skipped = skipTrivia(src, i);
    if (skipped !== i) { i = skipped - 1; continue; }
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  return '';
}

/** A `name :` or `"name" :` at position i - returns [name, offsetOfValue]. */
function keyAt(body, i) {
  const m = /^(["']?)(\w+)\1\s*:\s*/.exec(body.slice(i));
  return m ? [m[2], i + m[0].length] : null;
}

/** Offset of a top-level `key :` inside an object body, or -1. Keys are
 *  matched BEFORE string skipping - UI5 writes them both quoted and bare. */
function keyOffset(body, key) {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    if (depth === 0) {
      const hit = keyAt(body, i);
      if (hit && hit[0] === key) return hit[1];
    }
    const skipped = skipTrivia(body, i);
    if (skipped !== i) { i = skipped - 1; continue; }
    const c = body[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
  }
  return -1;
}

/** The value of a top-level `key : { ... }` inside an object body, or null. */
function section(body, key) {
  const at = keyOffset(body, key);
  if (at < 0 || body[at] !== '{') return null;
  return braceBody(body, at);
}

function declEntry(decl, doc) {
  const entry = {};
  const type = decl.match(/\btype\s*:\s*["']([\w.:/]+)["']/)?.[1];
  if (type) entry.type = type;
  if (/\bmultiple\s*:\s*true/.test(decl)) entry.multiple = true;
  /* An event's own parameters, kept PER EVENT rather than merged into the
   * flat member map: sap.m.Menu declares an `item` parameter on both
   * itemSelected (since forever) and beforeClose (@since 1.136), and one
   * flat entry cannot tell an app reading $parameters>/item which of the two
   * it is looking at. */
  const params = section(decl, 'parameters');
  if (params) {
    const parsed = declarations(params);
    if (Object.keys(parsed).length) entry.params = parsed;
  }
  const since = doc?.match(/@since\s+(?:version\s+)?([\d.]+)/i)?.[1];
  if (since) entry.since = since;
  const dep = doc?.match(/@deprecated(?:\s+As of(?:\s+version)?\s+([\d.]+))?([^\n]*)/i);
  if (dep) {
    // keep the version: a member deprecated in 1.120 is fine for a 1.71 target
    entry.deprecated = {
      since: dep[1] || null,
      text: (dep[2] || '').replace(/^[\s.,;:—-]+/, '').replace(/\s+/g, ' ').trim(),
    };
  }
  return entry;
}

/** Top-level declarations of one metadata section. Handles both the full
 *  form (`name : { type: "...", multiple: true }`) and UI5's shorthand
 *  (`name : "string"`), each with the @since of its preceding JSDoc block. */
function declarations(body) {
  if (!body) return {};
  const out = {};
  let doc = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '/' && body[i + 1] === '*') {
      const end = body.indexOf('*/', i + 2);
      doc = body.slice(i, end < 0 ? body.length : end);
      i = (end < 0 ? body.length : end + 2) - 1;
      continue;
    }
    // a key must be recognized BEFORE strings are skipped - UI5 writes them
    // both bare (text : {...}) and quoted ("text": {...})
    const hit = keyAt(body, i);
    if (hit) {
      const [name, valueAt] = hit;
      if (body[valueAt] === '{') {
        const decl = braceBody(body, valueAt);
        out[name] = declEntry(decl, doc);
        i = valueAt + decl.length + 1;
      } else {
        // shorthand: name : "type"
        const type = /^["']([\w.:/]+)["']/.exec(body.slice(valueAt));
        out[name] = declEntry(type ? `type: "${type[1]}"` : '', doc);
        i = valueAt + (type ? type[0].length : 0);
      }
      doc = '';
      continue;
    }
    const skipped = skipTrivia(body, i);
    if (skipped !== i) i = skipped - 1;
  }
  return out;
}

function classMeta(src, name) {
  const em = src.match(new RegExp(`\\.extend\\(\\s*["']${name.replace(/\./g, '\\.')}["']`));
  /* The class's own JSDoc is the LAST block before its .extend( ) call, with
   * nothing but the assignment in between. Scanning everything above the
   * extend instead picks up whatever @deprecated a neighbouring symbol
   * carries - which is how sap.f.DynamicPageTitle, a current control, came
   * out deprecated: the block above it belongs to a local
   * `var DynamicPageTitleArea = library.DynamicPageTitleArea;`. */
  const before = em ? src.slice(0, em.index) : src.slice(0, 4000);
  const blocks = [...before.matchAll(/\/\*\*([\s\S]*?)\*\//g)];
  const last = blocks[blocks.length - 1];
  // a `;` or `}` between the block and the extend means the block documents
  // that statement, not the class
  const header = last && !/[;}]/.test(before.slice(last.index + last[0].length))
    ? last[1]
    : '';
  const sinceM = header.match(/@(?:ui5-experimental-)?since\s+(?:version\s+)?([\d.]+)/i);
  const depM = header.match(/@deprecated(?:\s+As of(?:\s+version)?\s+([\d.]+))?([^\n]*)/i);
  return {
    since: sinceM ? sinceM[1] : null,
    deprecated: depM
      ? { since: depM[1] || null, text: (depM[2] || '').replace(/^[\s.,;:—-]+/, '').replace(/\s+/g, ' ').trim() }
      : null,
  };
}

/** Every class a file defines - a source file can hold several
 *  (HeaderContainer.js defines HeaderContainerItemContainer AND
 *  HeaderContainer), and taking only the first loses the rest. */
function parseControls(file, base) {
  const src = fs.readFileSync(file, 'utf8');
  const hits = [...src.matchAll(/(\w+)\.extend\(\s*["']([\w.]+)["']/g)];
  if (!hits.length) return [];

  // dependency -> parent resolution is file-wide (the sap.ui.define header)
  const defineDeps = src.match(/sap\.ui\.define\(\s*\[([^\]]*)\]/);
  const factory = src.match(/function\s*\(([^)]*)\)/);
  const parentOf = (extId) => {
    if (!extId || !defineDeps || !factory) return null;
    const deps = [...defineDeps[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    const params = factory[1].split(',').map((p) => p.trim());
    const i = params.indexOf(extId);
    return i >= 0 && deps[i] ? dotted(deps[i], base) : null;
  };

  return hits.map((hit, ix) => {
    // the class's own metadata block: the first one after its extend call,
    // bounded by where the next class starts
    const from = hit.index;
    const to = hits[ix + 1]?.index ?? src.length;
    const region = src.slice(from, to);
    const metaAt = region.search(/\bmetadata\s*:\s*\{/);
    const meta = metaAt >= 0 ? braceBody(region, region.indexOf('{', metaAt)) : '';
    return parseClass(src, region, meta, hit[2], parentOf(hit[1]));
  });
}

function parseClass(src, region, meta, name, parent) {

  const properties = declarations(section(meta, 'properties'));
  const aggregations = declarations(section(meta, 'aggregations'));
  const associations = declarations(section(meta, 'associations'));
  const events = declarations(section(meta, 'events'));
  const defaultAggregation = meta.match(/defaultAggregation\s*:\s*["'](\w+)["']/)?.[1] ?? null;
  const interfaces = [];
  const ifaceBlock = meta.match(/interfaces\s*:\s*\[([^\]]*)\]/);
  if (ifaceBlock) {
    interfaces.push(...[...ifaceBlock[1].matchAll(/["']([\w.]+)["']/g)].map((m) => m[1]));
  }

  // legacy shape kept for the @since floor check: member -> since
  const members = {};
  for (const set of [properties, aggregations, associations, events]) {
    for (const [k, v] of Object.entries(set)) if (v.since) members[k] = v.since;
  }
  // event PARAMETERS and other nested @since members the old parser saw too
  for (const m of region.matchAll(/\/\*\*((?:[^*]|\*(?!\/))*?)\*\/\s*(\w+)\s*:\s*\{/g)) {
    const since = m[1].match(/@since\s+(?:version\s+)?([\d.]+)/i)?.[1];
    if (since && members[m[2]] === undefined) members[m[2]] = since;
  }

  return {
    name, parent, members, properties, aggregations, associations, events,
    defaultAggregation, interfaces, ...classMeta(src, name),
  };
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** `Key: "Value"` pairs of an object literal body - the values are what an
 *  XML view may write for a property of that enum type. */
function enumValues(body) {
  const values = [...stripComments(body).matchAll(/["']?(\w+)["']?\s*:\s*["']([^"']*)["']/g)].map((v) => v[2]);
  return [...new Set(values)].filter(Boolean);
}

/** Enum values from a library.js: `thisLib.Name = { Key: "Value" }`. */
function parseLibraryEnums(file, lib) {
  const src = fs.readFileSync(file, 'utf8');
  const out = {};
  for (const m of src.matchAll(/thisLib\.(\w+)\s*=\s*\{/g)) {
    const values = enumValues(braceBody(src, src.indexOf('{', m.index + m[0].length - 1)));
    if (values.length) out[`${lib}.${m[1]}`] = values;
  }
  return out;
}

/** Enums declared in their own module:
 *    const Name = { Key: "Value" }; DataType.registerEnum("full.Name", Name)
 *  Also catches `@enum` modules whose object is exported directly. */
function parseModuleEnums(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = {};
  for (const m of src.matchAll(/DataType\.registerEnum\(\s*["']([\w.]+)["']\s*,\s*(\w+)\s*\)/g)) {
    const [, fullName, ident] = m;
    const declRe = new RegExp(`(?:var|const|let)\\s+${ident}\\s*=\\s*\\{`);
    const decl = src.match(declRe);
    if (!decl) continue;
    const values = enumValues(braceBody(src, src.indexOf('{', decl.index + decl[0].length - 1)));
    if (values.length) out[fullName] = values;
  }
  return out;
}

const controls = {};
const enums = {};
let files = 0;
const dirs = libDirs();
if (!dirs.length) {
  console.error('no control sources found - run npm ci, or set OPENUI5_DIR');
  process.exit(1);
}
for (const [base, dir] of dirs) {
  const lib = base.replace(/\//g, '.');
  const libJs = path.join(dir, 'library.js');
  if (fs.existsSync(libJs)) Object.assign(enums, parseLibraryEnums(libJs, lib));

  const acc = [];
  collect(dir, base, acc);
  for (const [file, fileBase] of acc) {
    Object.assign(enums, parseModuleEnums(file));
    for (const c of parseControls(file, fileBase)) {
      const entry = { parent: c.parent, members: c.members };
      if (c.since) entry.since = c.since;
      if (c.deprecated) entry.deprecated = c.deprecated;
      if (Object.keys(c.properties).length) entry.properties = c.properties;
      if (Object.keys(c.aggregations).length) entry.aggregations = c.aggregations;
      if (Object.keys(c.associations).length) entry.associations = c.associations;
      if (Object.keys(c.events).length) entry.events = c.events;
      if (c.defaultAggregation) entry.defaultAggregation = c.defaultAggregation;
      if (c.interfaces.length) entry.interfaces = c.interfaces;
      controls[c.name] = entry;
      files++;
    }
  }
}

/** The UI5 version these sources are - the @openui5 package version, or the
 *  OpenUI5 checkout's version. It bounds what the gate can know. */
function sourceVersion() {
  if (process.env.OPENUI5_DIR) {
    const p = path.join(process.env.OPENUI5_DIR, 'package.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')).version ?? null;
  }
  const pkg = path.join(ROOT, 'node_modules', '@openui5/sap.m', 'package.json');
  if (fs.existsSync(pkg)) return JSON.parse(fs.readFileSync(pkg, 'utf8')).version ?? null;
  return null;
}

const ui5Version = sourceVersion();

fs.writeFileSync(OUT, JSON.stringify({
  note: 'UI5 metadata snapshot: per control parent, @since/@deprecated, interfaces, defaultAggregation and all declared members with types; plus enum values. Generated by scripts/generate-metadata.mjs from the OpenUI5 sources.',
  ui5Version,
  enums,
  controls,
}) + '\n');

const withProps = Object.values(controls).filter((c) => c.properties).length;
const withAggs = Object.values(controls).filter((c) => c.aggregations).length;
console.log(
  `properties.json: ${files} controls (${withProps} with properties, ${withAggs} with aggregations), ` +
  `${Object.keys(enums).length} enums`
);
