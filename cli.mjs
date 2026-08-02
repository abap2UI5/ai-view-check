#!/usr/bin/env node
/*
 * view-check — validate abap2UI5 views without an SAP system.
 *
 *   npx view-check [paths...] [options]
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
 *   --min-ui5 <ver>    UI5 floor for the property gate (default 1.71)
 *   --allow <name>     allow a control or control.member despite the floor
 *                      (repeatable, e.g. --allow sap.m.Avatar.displaySize)
 *   --no-render        skip the render gate (no browser/@openui5 needed)
 *   --no-properties    skip the property gate
 *   --advisory         report only, always exit 0 (default: exit 1 on findings)
 *   --verbose          print reconstruction notes
 */
import path from 'path';
import { checkFiles, collectFiles } from './lib/index.mjs';

const args = process.argv.slice(2);
const opt = { minUi5: '1.71', allow: [], render: true, properties: true, advisory: false, verbose: false, json: false };
const paths = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--min-ui5') opt.minUi5 = args[++i];
  else if (a === '--allow') opt.allow.push(args[++i]);
  else if (a === '--no-render') opt.render = false;
  else if (a === '--no-properties') opt.properties = false;
  else if (a === '--advisory') opt.advisory = true;
  else if (a === '--verbose') opt.verbose = true;
  else if (a === '--json') opt.json = true;
  else if (a === '--help' || a === '-h') {
    console.log('usage: view-check [paths...] [--min-ui5 1.71] [--allow control[.member]] [--no-render] [--no-properties] [--advisory] [--json] [--verbose]');
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
  console.log(`view-check: no checkable files under ${paths.join(', ')} (ABAP classes using z2ui5_cl_ai_xml, *.view.xml, *.fragment.xml)`);
  process.exit(0);
}

const results = await checkFiles(files, opt);

let failing = 0;
let skipped = 0;
for (const r of results) {
  const rel = path.relative(process.cwd(), r.file);
  const problems = r.findings.length + r.renderErrors.length;
  if (r.skippedRender && !problems) {
    skipped++;
    if (!opt.json) console.log(`SKIP  ${rel}  (${r.helperTokens} builder call(s) in helper methods — not statically reconstructable, render gate skipped)`);
    continue;
  }
  if (problems) failing++;
  if (opt.json) continue;
  const status = problems ? 'FAIL' : 'pass';
  console.log(`${status}  ${rel}${r.docs.length ? `  (${r.docs.length} doc(s))` : ''}`);
  for (const f of r.findings) {
    if (f.type === 'control-too-new') console.log(`      control ${f.control} is @since ${f.since} — newer than the ${f.minUi5} floor`);
    else if (f.type === 'control-deprecated') console.log(`      control ${f.control} is deprecated (${String(f.deprecated).slice(0, 80)})`);
    else console.log(`      ${f.control} ${f.member} is @since ${f.since} — newer than the ${f.minUi5} floor`);
  }
  for (const e of r.renderErrors) console.log(`      render: ${e.slice(0, 220)}`);
  if (opt.verbose) for (const n of r.notes) console.log(`      note: ${n}`);
}

if (opt.json) {
  // machine-readable output for tool integrations (e.g. the VS Code
  // extension) — docs and model are omitted, they can be megabytes
  console.log(JSON.stringify({
    files: results.length,
    failing,
    skipped,
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
  console.log(`\nview-check: ${results.length} file(s), ${failing} failing, ${skipped} skipped.`);
}
if (!opt.advisory && failing > 0) process.exit(1);
