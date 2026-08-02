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
 *   --no-render        skip the render gate (no browser/@openui5 needed)
 *   --no-properties    skip the property gate
 *   --advisory         report only, always exit 0 (default: exit 1 on findings)
 *   --verbose          print reconstruction notes
 */
import path from 'path';
import { checkFiles, collectFiles } from './lib/index.mjs';
import { snapshotVersion } from './lib/properties.mjs';

const args = process.argv.slice(2);
const opt = { minUi5: '1.71', distribution: 'sapui5', allow: [], render: true, properties: true, advisory: false, verbose: false, json: false };
const paths = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--min-ui5' || a === '--ui5') opt.minUi5 = args[++i];
  else if (a === '--distribution') opt.distribution = String(args[++i]).toLowerCase();
  else if (a === '--openui5') opt.distribution = 'openui5';
  else if (a === '--allow') opt.allow.push(args[++i]);
  else if (a === '--no-render') opt.render = false;
  else if (a === '--no-properties') opt.properties = false;
  else if (a === '--advisory') opt.advisory = true;
  else if (a === '--verbose') opt.verbose = true;
  else if (a === '--json') opt.json = true;
  else if (a === '--help' || a === '-h') {
    console.log('usage: abap2ui5-linter [paths...] [--ui5 1.71] [--distribution sapui5|openui5] [--allow control[.member]] [--no-render] [--no-properties] [--advisory] [--json] [--verbose]');
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
    if (f.type === 'member-deprecated') console.log(`      ${f.control} ${f.member} is deprecated (${String(f.deprecated?.text || '').slice(0, 70)})`);
    else if (f.type === 'duplicate-aggregation') console.log(`      ${f.control} opens ${f.member} twice — the second tag replaces the first`);
    else if (f.type === 'unconverted-abap-boolean') console.log(`      ${f.member}: the ABAP boolean ${f.value} reaches the view as 'X'/' ' — wrap it in z2ui5_cl_ai_xml=>as_bool( )`);
    else if (f.type === 'unknown-binding-path') console.log(`      ${f.control} ${f.member}="{${f.value}}" — the model has no such path (silently empty)`);
    else if (f.type === 'binding-for-event') console.log(`      ${f.control} ${f.member} is an event but carries a binding — use client->_event( )`);
    else if (f.type === 'event-for-property') console.log(`      ${f.control} ${f.member} is a property but carries an event handler — use client->_bind( )`);
    else if (f.type === 'obsolete-binder') console.log(`      client->${f.member}( ) is obsolete — use client->_bind( )`);
    else if (f.type === 'binding-to-local') console.log(`      ${f.member} is a local variable — its value is lost after the roundtrip, bind an instance attribute`);
    else if (f.type === 'event-without-handler') console.log(`      event ${f.value} is raised but never handled — dead control, unless the roundtrip alone is intended`);
    else if (f.type === 'duplicate-id') console.log(`      id="${f.value}" is used twice — duplicate ID error at runtime`);
    else if (f.type === 'undeclared-namespace') console.log(`      namespace prefix '${f.member}' is used but never declared (xmlns:${f.member})`);
    else if (f.type === 'invalid-expression-binding') console.log(`      ${f.control} ${f.member}: unbalanced braces/parens in the expression binding`);
    else if (f.type === 'missing-accessibility') console.log(`      ${f.control} has no ${f.member} — not usable with a screen reader`);
    else if (f.type === 'sapui5-only-control') console.log(`      control ${f.control} needs SAPUI5 — ${f.library} is not part of OpenUI5`);
    else if (f.type === 'unknown-control') console.log(`      control ${f.control} does not exist in UI5 — typo?`);
    else if (f.type === 'control-too-new') console.log(`      control ${f.control} is @since ${f.since} — newer than the ${f.minUi5} floor`);
    else if (f.type === 'control-deprecated') console.log(`      control ${f.control} is deprecated (${String(f.deprecated).slice(0, 80)})`);
    else if (f.type === 'unknown-property') console.log(`      ${f.control} has no property/event/association ${f.member} — typo?`);
    else if (f.type === 'unknown-aggregation') console.log(`      ${f.control} has no aggregation ${f.member} — typo?`);
    else if (f.type === 'invalid-property-value') {
      const allowed = f.allowed ? `allowed: ${f.allowed.join(', ')}` : `expected ${f.memberType}`;
      console.log(`      ${f.control} ${f.member}="${f.value}" is not a valid value (${allowed})`);
    } else if (f.type === 'invalid-aggregation-child') {
      console.log(`      ${f.control} is not allowed in ${f.parentControl} ${f.member} (expects ${f.expected})`);
    } else if (f.type === 'too-many-children') {
      console.log(`      ${f.control} ${f.member} takes one child, ${f.count} given`);
    } else if (f.type === 'excess-shut') {
      console.log('      one shut( ) more than the tree is deep — asserts at runtime');
    } else console.log(`      ${f.control} ${f.member} is @since ${f.since} — newer than the ${f.minUi5} floor`);
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
  const snap = snapshotVersion();
  console.log(
    `\nabap2ui5-linter: ${results.length} file(s), ${failing} failing, ${skipped} skipped ` +
    `(target ${opt.distribution === 'openui5' ? 'OpenUI5' : 'SAPUI5'} ${opt.minUi5}${snap ? `, metadata from ${snap}` : ''}).`
  );
}
if (!opt.advisory && failing > 0) process.exit(1);
