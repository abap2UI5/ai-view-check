#!/usr/bin/env node
/*
 * abap2ui5-linter — validate abap2UI5 views without an SAP system.
 *
 *   npx abap2ui5-linter [paths...] [options]
 *
 * Paths are files or directories (default: ./src). Checked are ABAP classes
 * building views with z2ui5_cl_ai_xml, plus raw *.view.xml / *.fragment.xml.
 *
 * Gates:
 *   properties  every control/member written in the view against the UI5
 *               metadata snapshot (@since floor + deprecation)
 *   render      headless XMLView.create against the local OpenUI5 runtime
 *               with a typed mock model derived from the class
 *
 * Options:
 *   --ui5 <ver>        the UI5 version to check against - the version your
 *                      system runs (default 1.71, alias --min-ui5). Controls and
 *                      members introduced later are reported, as are
 *                      deprecations already in effect at that version.
 *   --distribution <d>  sapui5 (default) or openui5 - which distribution the
 *                      target system serves. On openui5, controls from
 *                      SAPUI5-only libraries (sap.ui.comp, sap.suite.*, ...)
 *                      are reported: they are simply not there. --openui5 is
 *                      a shorthand.
 *   --allow <name>     allow a control or control.member despite the floor
 *                      (repeatable, e.g. --allow sap.m.Avatar.displaySize)
 *   --fail-on <level>  lowest severity that fails the build: error, warning
 *                      (default), hint, or never. Every finding is always
 *                      reported - this only decides the exit code.
 *   --no-render        skip the render gate (no browser/@openui5 needed)
 *   --no-properties    skip the property gate
 *   --advisory         report only, always exit 0 (same as --fail-on never)
 *   --verbose          print reconstruction notes
 */
import path from 'path';
import { checkFiles, collectFiles } from './lib/index.mjs';
import { snapshotVersion } from './lib/properties.mjs';
import { SEVERITIES, severityRank, severityOf, describe } from './lib/findings.mjs';

const args = process.argv.slice(2);
const opt = { minUi5: '1.71', distribution: 'sapui5', allow: [], render: true, properties: true, failOn: 'warning', verbose: false, json: false };
const paths = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--min-ui5' || a === '--ui5') opt.minUi5 = args[++i];
  else if (a === '--distribution') opt.distribution = String(args[++i]).toLowerCase();
  else if (a === '--openui5') opt.distribution = 'openui5';
  else if (a === '--allow') opt.allow.push(args[++i]);
  else if (a === '--no-render') opt.render = false;
  else if (a === '--no-properties') opt.properties = false;
  else if (a === '--advisory') opt.failOn = 'never';
  else if (a === '--fail-on') {
    const level = String(args[++i]).toLowerCase();
    if (![...SEVERITIES, 'never'].includes(level)) {
      console.error(`abap2ui5-linter: --fail-on takes ${SEVERITIES.join(', ')} or never (got '${level}')`);
      process.exit(2);
    }
    opt.failOn = level;
  }
  else if (a === '--verbose') opt.verbose = true;
  else if (a === '--json') opt.json = true;
  else if (a === '--help' || a === '-h') {
    console.log('usage: abap2ui5-linter [paths...] [--ui5 1.71] [--distribution sapui5|openui5] [--allow control[.member]] [--fail-on error|warning|hint|never] [--no-render] [--no-properties] [--advisory] [--json] [--verbose]');
    process.exit(0);
  } else paths.push(a);
}
if (!paths.length) paths.push('src');

const files = collectFiles(paths);
if (!files.length) {
  if (opt.json) {
    console.log(JSON.stringify({ files: 0, failing: 0, skipped: 0, results: [] }));
    process.exit(0);
  }
  console.log(`abap2ui5-linter: no checkable files under ${paths.join(', ')} (ABAP classes using z2ui5_cl_ai_xml, *.view.xml, *.fragment.xml)`);
  process.exit(0);
}

const results = await checkFiles(files, opt);

const threshold = opt.failOn === 'never' ? Infinity : severityRank(opt.failOn);
/** Findings at or above the threshold decide the exit code - a hint never
 *  breaks a build unless it was asked to. Render errors always count: the
 *  view demonstrably did not load. */
const failsBuild = (r) =>
  r.renderErrors.length > 0 || r.findings.some((f) => severityRank(severityOf(f)) >= threshold);

let failing = 0;
let skipped = 0;
const totals = { error: 0, warning: 0, hint: 0 };
for (const r of results) {
  const rel = path.relative(process.cwd(), r.file);
  const problems = r.findings.length + r.renderErrors.length;
  for (const f of r.findings) totals[severityOf(f)]++;
  totals.error += r.renderErrors.length;
  if (r.skippedRender && !problems) {
    skipped++;
    if (!opt.json) console.log(`SKIP  ${rel}  (${r.helperTokens} builder call(s) in helper methods — not statically reconstructable, render gate skipped)`);
    continue;
  }
  const fails = failsBuild(r);
  if (fails) failing++;
  if (opt.json) continue;
  const status = fails ? 'FAIL' : problems ? 'warn' : 'pass';
  console.log(`${status}  ${rel}${r.docs.length ? `  (${r.docs.length} doc(s))` : ''}`);
  // in file order, the way a reader walks the source; findings the gates
  // could not place (an inlined helper chain) come last
  const ordered = [...r.findings].sort(
    (a, b) => (a.line ?? Infinity) - (b.line ?? Infinity) || (a.column ?? 0) - (b.column ?? 0)
  );
  for (const f of ordered) {
    const where = f.line ? `${f.line}:${f.column}` : '';
    console.log(`      ${where.padStart(8)}  ${severityOf(f).padEnd(7)}  ${f.message || describe(f)}`);
  }
  for (const e of r.renderErrors) {
    console.log(`      ${''.padStart(8)}  ${'error'.padEnd(7)}  render: ${e.slice(0, 220)}`);
  }
  if (opt.verbose) for (const n of r.notes) console.log(`      note: ${n}`);
}

if (opt.json) {
  // machine-readable output for tool integrations (e.g. the VS Code
  // extension) — docs and model are omitted, they can be megabytes
  console.log(JSON.stringify({
    files: results.length,
    failing,
    skipped,
    totals,
    failOn: opt.failOn,
    results: results.map((r) => ({
      file: r.file,
      kind: r.kind,
      usesBuilder: r.usesBuilder ?? true,
      findings: r.findings,
      renderErrors: r.renderErrors,
      skippedRender: r.skippedRender,
      helperTokens: r.helperTokens,
      notes: r.notes,
    })),
  }));
} else {
  const snap = snapshotVersion();
  const counted = SEVERITIES.map((s) => `${totals[s]} ${s}`).reverse().join(', ');
  console.log(
    `\nabap2ui5-linter: ${results.length} file(s), ${failing} failing, ${skipped} skipped — ${counted} ` +
    `(target ${opt.distribution === 'openui5' ? 'OpenUI5' : 'SAPUI5'} ${opt.minUi5}${snap ? `, metadata from ${snap}` : ''}` +
    `, failing on ${opt.failOn}).`
  );
}
if (failing > 0) process.exit(1);
