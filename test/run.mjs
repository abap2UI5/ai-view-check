#!/usr/bin/env node
/*
 * test/run — fixture-based self-test of the two gates.
 *
 *   good.clas.abap      reconstructs, no findings, renders clean
 *   post171.clas.abap   property gate: GenericTile.systemInfo @since 1.92
 *   broken.clas.abap    render gate: typo property + unknown control
 *   structure.clas.abap unknown control/property/aggregation, bad enum and
 *                       numeric values, 0..1 overfilled, excess shut( )
 *   dumps.clas.abap     builder calls z2ui5_cl_ai_xml ASSERTs on
 *   rowpaths.clas.abap  relative binding paths inside a bound aggregation
 *   nested.clas.abap    nested structures and nested aggregation bindings
 *   sample.view.xml     raw XML path: no findings, renders clean
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkAbapSource, checkFiles } from '../lib/index.mjs';
import { prepareAbap } from '../lib/reconstruct.mjs';
import { severityOf } from '../lib/findings.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const f = (n) => path.join(FIX, n);

let failed = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) failed++;
};

const results = await checkFiles(
  [f('good.clas.abap'), f('post171.clas.abap'), f('broken.clas.abap'), f('structure.clas.abap'), f('sample.view.xml')],
);
const by = (n) => results.find((r) => r.file.endsWith(n));

const good = by('good.clas.abap');
assert(good.docs.length === 1, 'good: one view reconstructed');
assert(good.model.NAME === 'world', 'good: bound scalar seeded from model_init');
assert(good.findings.length === 0, 'good: no property findings');
assert(good.renderErrors.length === 0, `good: renders clean (${good.renderErrors[0] || ''})`);

const post = by('post171.clas.abap');
assert(post.findings.some((x) => x.member === 'systemInfo' && x.type === 'member-too-new'),
  'post171: GenericTile.systemInfo flagged as member-too-new');

const broken = by('broken.clas.abap');
assert(broken.renderErrors.length > 0, 'broken: render gate reports errors');
assert(broken.renderErrors.some((e) => /textt|NoSuchControl/i.test(e)),
  `broken: error names the defect (${(broken.renderErrors[0] || '').slice(0, 80)})`);
assert(broken.findings.some((x) => x.type === 'unknown-control' && x.control === 'sap.m.NoSuchControl'),
  'broken: property gate flags the typo control without a browser');

const struct = by('structure.clas.abap');
const has = (type, pred = () => true) => struct.findings.some((f) => f.type === type && pred(f));
assert(has('unknown-control', (f) => f.control === 'sap.m.Buton'),
  'structure: unknown control flagged');
assert(has('unknown-property', (f) => f.control === 'sap.m.Button' && f.member === 'typ'),
  'structure: unknown property flagged');
assert(has('invalid-property-value', (f) => f.member === 'type' && f.allowed?.includes('Emphasized')),
  'structure: enum value outside the allowed set flagged, with the allowed values');
assert(has('invalid-property-value', (f) => f.member === 'percentValue' && f.memberType === 'float'),
  'structure: non-numeric value for a float property flagged');
assert(has('unknown-aggregation', (f) => f.control === 'sap.m.Page' && f.member === 'contentt'),
  'structure: unknown aggregation flagged');
assert(has('too-many-children', (f) => f.member === 'customHeader' && f.count === 2),
  'structure: second child in a 0..1 aggregation flagged');
assert(has('excess-shut'), 'structure: shut( ) past the root flagged (asserts at runtime)');

// the target UI5 version drives BOTH directions: too-new members are only
// a finding below it, deprecations only from the version they take effect
const depLate = await checkFiles([f('deprecated-late.clas.abap')], { render: false, minUi5: '1.71' });
assert(!depLate[0].findings.some((x) => x.type === 'control-deprecated'),
  'target version: a control deprecated after the target is not reported');
const depNow = await checkFiles([f('deprecated-late.clas.abap')], { render: false, minUi5: '1.150' });
assert(depNow[0].findings.some((x) => x.type === 'control-deprecated'),
  'target version: the same control IS reported when the target reaches its deprecation');

// SAPUI5 vs OpenUI5: the same view is fine on one distribution and broken
// on the other, because sap.ui.comp simply does not ship with OpenUI5
const smartSap = await checkFiles([f('smart.clas.abap')], { render: false });
assert(!smartSap[0].findings.some((x) => x.type === 'sapui5-only-control'),
  'distribution: a SAPUI5-only control is accepted on SAPUI5 (the default)');
const smartOpen = await checkFiles([f('smart.clas.abap')], { render: false, distribution: 'openui5' });
assert(smartOpen[0].findings.some(
  (x) => x.type === 'sapui5-only-control' && x.library === 'sap.ui.comp'),
  'distribution: the same control is reported on OpenUI5');
assert(!smartOpen[0].findings.some((x) => x.type === 'unknown-control'),
  'distribution: a SAPUI5-only control is never mistaken for a typo');

// abap2UI5-specific defects: silent at runtime, invisible to UI5 tooling
const rules = (await checkFiles([f('abaprules.clas.abap')], { render: false }))[0];
const hasR = (t, pred = () => true) => rules.findings.some((x) => x.type === t && pred(x));
assert(hasR('obsolete-binder', (x) => x.member === '_bind_edit'),
  'abap rules: _bind_edit reported as obsolete (use _bind)');
// ... except where z2ui5_if_client itself says to keep using it: _bind has
// no custom_mapper_back/custom_filter_back
assert(!checkAbapSource(
  'client->_bind_edit( val = name custom_mapper_back = mapper )', { render: false }
).findings.some((x) => x.type === 'obsolete-binder'),
'abap rules: _bind_edit is not obsolete where it carries custom_mapper_back');
assert(hasR('binding-to-local', (x) => x.member === 'lv_local'),
  'abap rules: a local variable bound - lost after the roundtrip');
assert(hasR('event-without-handler', (x) => x.value === 'NO_HANDLER'),
  'abap rules: an event nothing handles');
assert(hasR('unconverted-abap-boolean', (x) => x.member === 'expanded' && x.value === 'abap_true'),
  'abap rules: an ABAP boolean written into the view without as_bool( )');
assert(hasR('unknown-binding-path', (x) => x.value === '/TYPOED_PATH'),
  'abap rules: a hand-written binding path the model does not have');
assert(hasR('event-arg-unresolved', (x) => x.value === '{BARE_BRACE}'),
  'abap rules: a bare-brace t_arg arrives empty - must be $-prefixed');
assert(!hasR('event-arg-unresolved', (x) => x.value.includes('RESOLVED')),
  'abap rules: a $-prefixed t_arg is fine');
assert(!hasR('event-arg-unresolved', (x) => x.value.startsWith('{0}')),
  'abap rules: a {N} template placeholder t_arg is quoted, not empty');
assert(!hasR('event-arg-unresolved', (x) => /lv_local/.test(x.value)),
  'abap rules: |{ var }| is an ABAP string template - interpolated server-side, not a binding');
assert(!hasR('event-arg-unresolved', (x) => /URL:/.test(x.value)),
  'abap rules: a brace object in a FRONTEND action t_arg (_event_client) is its parameter set, not a binding');

const vr = (await checkFiles([f('viewrules.clas.abap')], { render: false }))[0];
const hasV = (t, pred = () => true) => vr.findings.some((x) => x.type === t && pred(x));
assert(hasV('binding-for-event', (x) => x.member === 'press'),
  'view rules: a binding on an event (use _event)');
assert(hasV('duplicate-id', (x) => x.value === 'twice'), 'view rules: duplicate id');
assert(hasV('undeclared-namespace', (x) => x.member === 'undeclared'),
  'view rules: namespace prefix used but never declared');
assert(hasV('missing-accessibility', (x) => x.member === 'tooltip'),
  'view rules: icon-only button without a tooltip');
assert(hasV('duplicate-aggregation', (x) => x.member === 'content'),
  'view rules: the same aggregation opened twice under one control');
assert(hasV('member-deprecated', (x) => x.member === 'translucent'),
  'view rules: a deprecated property reported (version-aware, like controls)');
assert(hasV('missing-required-aggregation', (x) => x.member === 'columns'),
  'view rules: a Table bound to rows but given no columns');
assert(hasV('event-for-property', (x) => x.member === 'tooltip'),
  'view rules: an event handler written into a property slot');
assert(hasV('collection-bound-to-property', (x) => x.member === 'headerText'),
  'view rules: a table bound to a scalar property');
assert(!hasV('invalid-expression-binding'),
  'view rules: a well-formed expression binding is not flagged');

// the builder ASSERTs the app never survives: a( ) with nothing to attach it
// to, and one attribute name written twice on the same control
const dumps = (await checkFiles([f('dumps.clas.abap')], { render: false }))[0];
const hasD = (t, pred = () => true) => dumps.findings.some((x) => x.type === t && pred(x));
assert(hasD('attribute-without-element', (x) => x.member === 'title'),
  'dumps: a( ) on the bare factory root - z2ui5_cl_ai_xml asserts');
assert(hasD('duplicate-property', (x) => x.member === 'text' && x.control === 'Button'),
  'dumps: the same attribute set twice on one control - z2ui5_cl_ai_xml asserts');
assert(dumps.docs[0].split('text="').length === 2,
  'dumps: the refused duplicate is not carried into the reconstructed XML');

// every finding carries where it came from, what it means and how bad it is -
// so an editor can place it and a build can decide on it
const posSrc = fs.readFileSync(f('dumps.clas.abap'), 'utf8').split('\n');
const dup = dumps.findings.find((x) => x.type === 'duplicate-property');
assert(dup.line > 0 && posSrc[dup.line - 1].includes('Save and close'),
  `dumps: the finding points at the SECOND text attribute (line ${dup.line})`);
assert(posSrc[dup.line - 1].slice(dup.column - 1).startsWith('->a('),
  `dumps: the column points at the a( ) call itself (col ${dup.column})`);
assert(dup.severity === 'error' && typeof dup.message === 'string' && dup.message.length > 10,
  'findings: severity and a ready-made message travel with the finding');

// severity is the linter's judgement, not the caller's guesswork
assert(severityOf({ type: 'unknown-control' }) === 'error',
  'severity: a control that does not exist breaks the app - error');
assert(severityOf({ type: 'control-too-new' }) === 'warning',
  'severity: the version floor is a portability warning');
assert(severityOf({ type: 'event-without-handler' }) === 'hint',
  'severity: an unhandled event is a hint - the roundtrip alone may be the point');
assert(severityOf({ type: 'brand-new-rule-nobody-classified' }) === 'error',
  'severity: an unclassified type stays loud rather than being silently dropped');

// a relative {NAME} inside a bound aggregation addresses the ROW - with the
// row's shape known from the class's TYPES, a typo'd column is catchable
const rows = (await checkFiles([f('rowpaths.clas.abap')], { render: false }))[0];
const rowPathFindings = rows.findings.filter((x) => x.type === 'unknown-binding-path');
assert(rowPathFindings.length === 1 && rowPathFindings[0].value === 'CARID',
  `rows: the typo'd row field is the only one reported (${rowPathFindings.map((x) => x.value).join(', ')})`);
assert(rowPathFindings[0].context === '/T_FLIGHTS',
  'rows: the finding names the aggregation binding the row came from');
assert(!rows.findings.some((x) => x.value === 'SEATSMAX'),
  'rows: a declared but unseeded field is part of the row - an ABAP structure always has all of them');
assert(!rows.findings.some((x) => x.value === 'CARRID'),
  'rows: a column header under `columns` is not in the row context and is left alone');

// a nested aggregation binding moves the context DOWN - including the
// complex {path: '...'} form the templates actually use
const nested = (await checkFiles([f('nested.clas.abap')], { render: false }))[0];
const nestedPaths = nested.findings.filter((x) => x.type === 'unknown-binding-path');
assert(nestedPaths.length === 1 && nestedPaths[0].value === 'EXPENSE'
  && nestedPaths[0].context === 'ELEMENTS',
  `nested: inside the inner list only its own row fields exist (${nestedPaths.map((x) => x.value).join(', ')})`);
assert(!nested.findings.some((x) => String(x.value).startsWith('AMOUNT/')),
  'nested: a path through a nested structure resolves');

// the model handed to the RENDERER stays what a seed actually sets: a field
// the class fills in code cannot be followed statically, and inventing an
// empty string for it makes UI5 strict mode reject a good view
const prep = prepareAbap(fs.readFileSync(f('nested.clas.abap'), 'utf8'));
assert(!('ELEMENTS' in prep.model.T_ROWS[0]) && 'ELEMENTS' in prep.modelShape.T_ROWS[0],
  'model: the unseeded field is in the shape the gate asks about, not in the render model');
assert(prep.model.T_ROWS[0].AMOUNT.SIZE === 560,
  'model: a nested structure seed parses as one structure, not as an empty table');

// no row shape, no verdict: a table of a type the class does not declare
// could have any field, so nothing there is reported
const opaque = `CLASS zcl_x DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
  PRIVATE SECTION.
    DATA t_flights TYPE STANDARD TABLE OF sflight.
ENDCLASS.
CLASS zcl_x IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA(view) = z2ui5_cl_ai_xml=>factory( ).
    view->open( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\`     v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
        )->open( \`List\`
            )->a( n = \`items\` v = client->_bind( t_flights )
            )->open( \`items\`
                )->leaf( \`StandardListItem\`
                    )->a( n = \`title\` v = \`{ANYTHING_AT_ALL}\`
        )->shut( )->shut( )->shut( ).
    client->view_display( view->stringify( ) ).
  ENDMETHOD.
ENDCLASS.`;
assert(!checkAbapSource(opaque, { render: false }).findings
  .some((x) => x.type === 'unknown-binding-path'),
  'rows: nothing is claimed about a row type the class does not declare');

// event parameters an app reads back ($parameters>/name) are members of the
// control like any other - and they are resolved PER EVENT, because two
// events of one control can declare the same name with different histories
const withEvent = (control, event, param) => checkAbapSource(`
  DATA(view) = z2ui5_cl_ai_xml=>factory( ).
  view->open( n = \`View\` ns = \`mvc\`
      )->a( n = \`xmlns\`     v = \`sap.m\`
      )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
      )->leaf( \`${control}\`
          )->a( n = \`${event}\` v = client->_event( val = \`GO\` t_arg = VALUE #( ( \`\${$parameters>/${param}}\` ) ) ) ).
  client->view_display( view->stringify( ) ).`, { render: false })
  .findings.filter((x) => x.type === 'event-parameter-too-new');

assert(withEvent('SearchField', 'search', 'searchButtonPressed')
  .some((x) => x.member === 'searchButtonPressed' && x.since === '1.114'),
  'event params: one newer than the floor is reported');
assert(!withEvent('SearchField', 'search', 'query').length,
  'event params: one without an @since predates version tracking and is not');
assert(withEvent('Menu', 'beforeClose', 'item').length === 1,
  'event params: Menu beforeClose/item is @since 1.136');
assert(!withEvent('Menu', 'itemSelected', 'item').length,
  'event params: Menu itemSelected/item is NOT - same name, different event, and only the flat member map confuses the two');

// an aggregation directly inside another aggregation: invalid XML, and the
// signature of a missing shut( ) - the port that put <footer> inside <columns>
// only ever surfaced as "failed to load sap/ui/table/footer.js" in the browser
const view = (inner) => `
  DATA(view) = z2ui5_cl_ai_xml=>factory( ).
  view->open( n = \`View\` ns = \`mvc\`
      )->a( n = \`xmlns\`     v = \`sap.m\`
      )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
      )->a( n = \`xmlns:my\`  v = \`my.custom.lib\`
      ${inner}.
  client->view_display( view->stringify( ) ).`;
const misplaced = (src) => checkAbapSource(src, { render: false })
  .findings.filter((x) => x.type === 'aggregation-in-aggregation');

assert(misplaced(view('  )->open( `Table` )->open( `columns` )->leaf( `Column` )->open( `footer` )'))
  .some((x) => x.member === 'footer' && x.parentAggregation === 'columns'),
  'missing shut: an aggregation inside an aggregation is reported');
assert(!misplaced(view('  )->open( `Table` )->open( `columns` )->open( `Column` )->open( `header` )')).length,
  'missing shut: a well-formed aggregation/control/aggregation nesting is not');
assert(!misplaced(view('  )->open( `Table` )->open( `columns` )->open( n = `Thing` ns = `my` )->open( `content` )')).length,
  'missing shut: a control from an unknown library still counts as a control in between');

// a tag in a foreign namespace (raw XHTML, a custom-control library) is not
// a UI5 aggregation of its parent - it is outside what the metadata can judge
const foreign = checkAbapSource(`
  DATA(view) = z2ui5_cl_ai_xml=>factory( ).
  view->open( n = \`View\` ns = \`mvc\`
      )->a( n = \`xmlns\`      v = \`sap.m\`
      )->a( n = \`xmlns:mvc\`  v = \`sap.ui.core.mvc\`
      )->a( n = \`xmlns:html\` v = \`http://www.w3.org/1999/xhtml\`
      )->open( \`Panel\`
          )->leaf( n = \`iframe\` ns = \`html\`
              )->a( n = \`src\` v = \`https://example.org\` ).
  client->view_display( view->stringify( ) ).`, { render: false });
assert(!foreign.findings.some((x) => x.type === 'unknown-aggregation'),
  'foreign namespace: html:iframe is left alone, not read as an aggregation of Panel');

// positions in raw XML are just as exact as in a builder class
const xmlPos = (await checkFiles([f('badvalue.view.xml')], { render: false }))[0];
const bad = xmlPos.findings.find((x) => x.type === "invalid-property-value");
assert(bad?.line === 4 && bad?.column === 15,
  `xml: the invalid value is located at 4:15 (got ${bad?.line}:${bad?.column})`);

const xml = by('sample.view.xml');
assert(xml.kind === 'xml', 'xml: raw view detected');
assert(xml.findings.length === 0, 'xml: no property findings');
assert(xml.renderErrors.length === 0, `xml: renders clean (${xml.renderErrors[0] || ''})`);


// a view that is built and never handed to the client
{
  const nd = (await checkFiles([f('nodisplay.clas.abap')], { render: false }))[0];
  assert(nd.findings.some((x) => x.type === 'view-never-displayed'),
    'abap rules: a view built but never displayed - an empty page, no error');
  const shown = (await checkFiles([f('good.clas.abap')], { render: false }))[0];
  assert(!shown.findings.some((x) => x.type === 'view-never-displayed'),
    'abap rules: a displayed view is not reported');
}

// ---------------------------------------------------------------- config ----
{
  const os = await import('node:os');
  const cp = await import('node:child_process');
  const { stripJsonc, loadConfig, applyConfig, findConfig, CONFIG_NAME } = await import('../lib/config.mjs');
  const CLI = path.join(FIX, '..', '..', 'cli.mjs');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5lint-'));
  const sub = path.join(dir, 'nested', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  const cfgFile = path.join(dir, CONFIG_NAME);
  fs.writeFileSync(cfgFile, `{
  // comment survives
  "ui5": "1.96",
  "failOn": "hint",
  "render": false,
  "allow": ["sap.m.Avatar"], // trailing comma next
}`);

  assert(JSON.parse(stripJsonc('{"a":1,/*x*/"b":"//not a comment",}')).b === '//not a comment',
    'config: stripJsonc keeps // inside strings');

  const cfg = loadConfig(cfgFile);
  assert(cfg.minUi5 === '1.96' && cfg.failOn === 'hint' && cfg.render === false,
    'config: jsonc parsed with comments and trailing commas');

  assert(findConfig(sub) === cfgFile, 'config: discovered walking upward from a nested dir');

  const opt = { minUi5: '1.71', failOn: 'warning', render: true, allow: ['sap.m.Page.x'] };
  applyConfig(opt, new Set(['failOn']), cfg);
  assert(opt.minUi5 === '1.96', 'config: fills an option the CLI did not set');
  assert(opt.failOn === 'warning', 'config: an explicit CLI flag beats the config');
  assert(opt.allow.includes('sap.m.Avatar') && opt.allow.includes('sap.m.Page.x'),
    'config: allow lists merge');

  let threw = '';
  fs.writeFileSync(path.join(dir, 'bad.jsonc'), '{"tpyo": 1}');
  try { loadConfig(path.join(dir, 'bad.jsonc')); }
  catch (e) { threw = e.message; }
  assert(/unknown key 'tpyo'/.test(threw), 'config: an unknown key fails loudly');

  // end-to-end: the CLI picks the config up from the checked path's directory
  // (cwd is this repo, which has no config - discovery must come from the path)
  fs.copyFileSync(f('good.clas.abap'), path.join(sub, 'good.clas.abap'));
  const out = cp.execFileSync('node', [CLI, path.join(sub, 'good.clas.abap')], { encoding: 'utf8' });
  assert(/target SAPUI5 1\.96/.test(out) && /failing on hint/.test(out),
    'config: cli applies ui5/failOn from the discovered abap2ui5lint.jsonc');
  const off = cp.execFileSync('node', [CLI, path.join(sub, 'good.clas.abap'), '--no-config'], { encoding: 'utf8' });
  assert(/target SAPUI5 1\.71/.test(off), 'config: --no-config restores the defaults');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} assertion(s) failed` : '\nall assertions passed');
process.exit(failed ? 1 : 0);
