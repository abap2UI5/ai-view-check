#!/usr/bin/env node
/*
 * check-upstream — drift gate for the HAND-MAINTAINED knowledge files.
 *
 * Two files in lib/ mirror closed sets that live in the abap2UI5 repo:
 *
 *   lib/formatters.mjs        <- app/webapp/model/formatter.js
 *   lib/frontend-actions.mjs  <- src/01/03/z2ui5_cl_app_frontendaction_js.clas.abap
 *                                (the GLOBAL_TARGETS map inside the embedded JS)
 *
 * Upstream is not a dependency here, so a change there is a SILENT breaking
 * change: a new CONTROL_GLOBAL target makes the linter report correct new
 * code as invalid-frontend-action (that is exactly how POPUP.setWithinArea
 * arrived), and a removed formatter makes the render harness pass views that
 * break live. This script compares the mirrors against the current upstream
 * sources and exits 1 on any drift — the scheduled workflow turns that into
 * an issue instead of waiting for a user to hit it.
 *
 *   node scripts/check-upstream.mjs                    fetch from GitHub main
 *   node scripts/check-upstream.mjs --local <dir>      read an abap2UI5 checkout
 *
 * Exit codes: 0 in sync, 1 drift, 2 sources unreachable.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CURATED_FORMATTERS } from '../lib/formatters.mjs';
import { GLOBAL_TARGETS, CSS_PROPERTIES } from '../lib/frontend-actions.mjs';

const RAW = 'https://raw.githubusercontent.com/abap2UI5/abap2UI5/main';
const FORMATTER_PATH = 'app/webapp/model/formatter.js';
const ACTION_PATH = 'src/01/03/z2ui5_cl_app_frontendaction_js.clas.abap';

/** Export surface of the curated formatter module: the top-level method
 *  names of its returned object literal (4-space indent, `Name(args) {`). */
export function parseFormatterExports(src) {
  return [...src.matchAll(/^    (\w+)\((?:[^)]*)\)?\s*\{?/gm)]
    .map((m) => m[1])
    .filter((n) => !['function', 'if', 'for', 'while', 'return', 'switch'].includes(n));
}

/** The JS the ABAP class embeds: every backtick literal's content, joined —
 *  the class is one string concatenation with `&& |\n| &&` line glue, so the
 *  literals ARE the JS lines. */
export function embeddedJs(abapSrc) {
  return [...abapSrc.matchAll(/`((?:[^`]|``)*)`/g)]
    .map((m) => m[1].replace(/``/g, '`'))
    .join('\n');
}

/** Body of the balanced { … } starting at src[open] === '{'. The region holds
 *  object literals and arrow functions only — no braces inside strings. */
function braceRegion(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** GLOBAL_TARGETS of the embedded FrontendAction JS: name -> [methods].
 *  Entries span one line (MESSAGE_TOAST) or many (MESSAGE_BOX), so the map
 *  is parsed brace-aware from the reconstructed JS, not line by line. */
export function parseGlobalTargets(abapSrc) {
  const js = embeddedJs(abapSrc);
  const out = {};
  const at = js.indexOf('const GLOBAL_TARGETS = {');
  if (at === -1) return out;
  const body = braceRegion(js, js.indexOf('{', at));
  const entryRe = /([A-Z][A-Z0-9_]*)\s*:\s*\{/g;
  let m;
  while ((m = entryRe.exec(body)) !== null) {
    const open = body.indexOf('{', m.index + m[0].length - 1);
    const entry = braceRegion(body, open);
    const methodsAt = entry.search(/methods\s*:\s*\{/);
    if (methodsAt !== -1) {
      const methods = braceRegion(entry, entry.indexOf('{', methodsAt));
      // a `//` comment documenting the payload shape ("{ CODE: { digits: n } }")
      // carries `word:` pairs that are not methods - drop the comments first
      // (`://` of a URL is not a comment start)
      const code = methods.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      out[m[1]] = [...code.matchAll(/(\w+)\s*:/g)].map((x) => x[1]);
    }
    entryRe.lastIndex = open + entry.length + 2; // never match inside the entry
  }
  return out;
}

/** The CSS_PROPERTIES array literal of FrontendAction.js: the quoted entries
 *  between `const CSS_PROPERTIES = [` and its closing bracket. */
export function parseCssProperties(abapSrc) {
  const js = embeddedJs(abapSrc);
  const at = js.indexOf('const CSS_PROPERTIES = [');
  if (at === -1) return [];
  const end = js.indexOf('];', at);
  if (end === -1) return [];
  return [...js.slice(at, end).matchAll(/["'`]([a-z-]+)["'`]/g)].map((m) => m[1]);
}

const setDiff = (a, b) => a.filter((x) => !b.includes(x));

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const localAt = process.argv.indexOf('--local');
  const LOCAL = localAt !== -1 ? process.argv[localAt + 1] : null;
  if (localAt !== -1 && !LOCAL) {
    console.error('check-upstream: --local needs the path of an abap2UI5 checkout');
    process.exit(2);
  }

  let formatterSrc;
  let actionSrc;
  try {
    if (LOCAL) {
      formatterSrc = fs.readFileSync(path.join(LOCAL, FORMATTER_PATH), 'utf8');
      actionSrc = fs.readFileSync(path.join(LOCAL, ACTION_PATH), 'utf8');
    } else {
      [formatterSrc, actionSrc] = await Promise.all([
        fetchText(`${RAW}/${FORMATTER_PATH}`),
        fetchText(`${RAW}/${ACTION_PATH}`),
      ]);
    }
  } catch (e) {
    console.error(`check-upstream: cannot read the upstream sources — ${e.message}`);
    console.error('(if a file moved upstream, update FORMATTER_PATH/ACTION_PATH here)');
    process.exit(2);
  }

  let drift = 0;
  const report = (what, ours, theirs) => {
    const missingHere = setDiff(theirs, ours);
    const staleHere = setDiff(ours, theirs);
    if (!missingHere.length && !staleHere.length) {
      console.log(`ok    ${what}: in sync (${ours.length} entr${ours.length === 1 ? 'y' : 'ies'})`);
      return;
    }
    drift++;
    console.log(`DRIFT ${what}:`);
    for (const n of missingHere) console.log(`  + upstream has '${n}' — missing here (correct new code gets reported until it is added)`);
    for (const n of staleHere) console.log(`  - '${n}' is gone upstream — stale here (broken code passes until it is removed)`);
  };

  report('curated formatters (lib/formatters.mjs)', [...CURATED_FORMATTERS], parseFormatterExports(formatterSrc));

  const upstreamTargets = parseGlobalTargets(actionSrc);
  if (!Object.keys(upstreamTargets).length) {
    console.error('check-upstream: could not find GLOBAL_TARGETS in the frontendaction class — the embedding changed, update parseGlobalTargets');
    process.exit(2);
  }
  report('CONTROL_GLOBAL targets (lib/frontend-actions.mjs)', Object.keys(GLOBAL_TARGETS), Object.keys(upstreamTargets));
  // the css pseudo-method's property allowlist is a second closed set in the
  // same file - a property the frontend dropped silently is exactly what the
  // linter is here to catch, so the mirror must not drift either
  const upstreamCss = parseCssProperties(actionSrc);
  if (upstreamCss.length) report('CONTROL_BY_ID css properties (lib/frontend-actions.mjs)', CSS_PROPERTIES, upstreamCss);
  for (const name of Object.keys(GLOBAL_TARGETS)) {
    if (upstreamTargets[name]) {
      report(`CONTROL_GLOBAL ${name} methods`, GLOBAL_TARGETS[name], upstreamTargets[name]);
    }
  }

  if (drift) {
    console.log('\ncheck-upstream: the hand-maintained mirrors drifted — update them (and their tests/fixtures) in one change.');
    process.exit(1);
  }
  console.log('\ncheck-upstream: all mirrors in sync.');
}
