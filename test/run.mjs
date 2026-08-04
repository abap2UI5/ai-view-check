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

// a DATA declared with a NAMED table type is a table too — the inline
// `STANDARD TABLE OF` form is not the only one the corpus writes
{
  const named = prepareAbap(`CLASS zcl_named DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES: BEGIN OF ty_s_row, name TYPE string, END OF ty_s_row.
    TYPES ty_t_row TYPE STANDARD TABLE OF ty_s_row WITH EMPTY KEY.
    DATA t_rows TYPE ty_t_row.
    DATA t_late TYPE ty_t_row.
ENDCLASS.
CLASS zcl_named IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    t_rows = VALUE #( ( name = \`Notebook\` ) ).
    DATA(v) = z2ui5_cl_ai_xml=>factory( ).
    v->open( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\` v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
        )->open( \`List\`
            )->a( n = \`items\` v = client->_bind( t_rows )
            )->open( \`items\`
                )->leaf( \`StandardListItem\`
                    )->a( n = \`title\` v = \`{NAME}\`
        )->shut( ).
    v->open( \`List\` )->a( n = \`items\` v = client->_bind( t_late ) ).
    client->view_display( v->stringify( ) ).
  ENDMETHOD.
ENDCLASS.`);
  assert(Array.isArray(named.model.T_ROWS) && named.model.T_ROWS[0].NAME === 'Notebook',
    'model: a DATA with a named table type is a table, not a scalar');
  // an UNSEEDED table: the shape keeps a declared row so paths stay judgeable,
  // the render model gets nothing — an invented all-empty row is instantiated
  // by the render gate and then fails strict validation on the first enum
  assert(named.model.T_LATE.length === 0 && named.modelShape.T_LATE.length === 1
    && 'NAME' in named.modelShape.T_LATE[0],
    'model: an unseeded table is empty for the renderer and a declared row in the shape');
}

// no row shape, no verdict: a table of a type the class does not declare
// could have any field, so nothing there is reported
const opaque = `CLASS zcl_x DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
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

// a control the aggregation's type does not accept: UI5 refuses the child and
// the part of the view below it silently disappears
const childOf = (inner) => checkAbapSource(view(inner), { render: false })
  .findings.filter((x) => x.type === 'invalid-aggregation-child');
assert(childOf('  )->open( `Table` )->open( `columns` )->leaf( `Button` )')
  .some((x) => x.control === 'sap.m.Button' && x.parentControl === 'sap.m.Table'
    && x.member === 'columns' && x.expected === 'sap.m.Column'),
  'aggregation child: a Button inside Table columns is reported with the expected type');
assert(!childOf('  )->open( `Table` )->open( `columns` )->leaf( `Column` )').length,
  'aggregation child: the type the aggregation declares is accepted');

// levels left open at stringify( ) are harmless (render( ) closes the tree) -
// a note for --verbose, never a finding
{
  const open = prepareAbap(view('  )->open( `Page` )->leaf( `Button` )'));
  assert(open.notes.some((n) => /level\(s\) left open/.test(n)),
    'open levels: an unshut tree at stringify( ) is noted');
  assert(!checkAbapSource(view('  )->open( `Page` )->leaf( `Button` )'), { render: false })
    .findings.some((x) => x.type === 'open-levels'),
    'open levels: the note never becomes a finding');
}

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
  const env = { ...process.env, NO_COLOR: '1', GITHUB_ACTIONS: '' }; // never inherit the runner's
  const out = cp.execFileSync('node', [CLI, path.join(sub, 'good.clas.abap')], { encoding: 'utf8', env });
  assert(/target SAPUI5 1\.96/.test(out) && /failing on hint/.test(out),
    'config: cli applies ui5/failOn from the discovered abap2ui5lint.jsonc');
  const off = cp.execFileSync('node', [CLI, path.join(sub, 'good.clas.abap'), '--no-config'], { encoding: 'utf8', env });
  assert(/target SAPUI5 1\.71/.test(off), 'config: --no-config restores the defaults');

  // the .json spelling is discovered too (abaplint.json / abaplint.jsonc)
  const plain = path.join(dir, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'abap2ui5lint.json'), '{"ui5": "1.120"}');
  assert(findConfig(plain) === path.join(plain, 'abap2ui5lint.json'),
    'config: abap2ui5lint.json is discovered as well as .jsonc');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ----------------------------------------------------------------- rules ----
// per-rule off / severity / exclude, the abaplint-shaped `rules` block
{
  const { loadConfig } = await import('../lib/config.mjs');
  const os = await import('node:os');
  const src = fs.readFileSync(f('viewrules.clas.abap'), 'utf8');

  const plain = checkAbapSource(src);
  const has = (r, type) => r.findings.some((x) => x.type === type);
  assert(has(plain, 'missing-accessibility') && has(plain, 'member-deprecated'),
    'rules: the fixture reports the rules the overrides act on');

  const off = checkAbapSource(src, { rules: { 'missing-accessibility': false } });
  assert(!has(off, 'missing-accessibility') && has(off, 'member-deprecated'),
    'rules: false switches a single rule off and leaves the rest alone');

  const lowered = checkAbapSource(src, { rules: { 'member-deprecated': 'hint' } });
  const dep = lowered.findings.find((x) => x.type === 'member-deprecated');
  assert(dep.severity === 'hint' && severityOf(dep) === 'hint',
    'rules: a severity string overrides the default, and severityOf reads it back');

  const excluded = checkAbapSource(src, { rules: { 'duplicate-id': { exclude: ['viewrules'] } }, file: 'src/viewrules.clas.abap' });
  assert(!has(excluded, 'duplicate-id'), 'rules: exclude drops the rule for a file the pattern matches');
  const kept = checkAbapSource(src, { rules: { 'duplicate-id': { exclude: ['nothing'] } }, file: 'src/viewrules.clas.abap' });
  assert(has(kept, 'duplicate-id'), 'rules: a non-matching exclude leaves the rule in place');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5rules-'));
  const write = (body) => { const p = path.join(dir, 'abap2ui5lint.jsonc'); fs.writeFileSync(p, body); return p; };
  const throws = (body) => { try { loadConfig(write(body)); return ''; } catch (e) { return e.message; } };
  assert(/unknown rule 'no-such-rule'/.test(throws('{"rules": {"no-such-rule": false}}')),
    'rules: an unknown rule id in the config fails loudly');
  assert(/must be a severity/.test(throws('{"rules": {"duplicate-id": "fatal"}}')),
    'rules: an unknown severity fails loudly');
  assert(/unknown key 'sevrity'/.test(throws('{"rules": {"duplicate-id": {"sevrity": "hint"}}}')),
    'rules: a typo inside a rule object fails loudly');
  assert(loadConfig(write('{"$schema": "x", "rules": {"duplicate-id": {"severity": "hint", "exclude": ["/test/"]}}}')).rules['duplicate-id'].severity === 'hint',
    'rules: $schema is accepted and a full rule object survives loading');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------ directives ----
// " abap2ui5lint-disable-next-line <rule>, -disable-line, -disable/-enable
{
  const src = fs.readFileSync(f('directives.clas.abap'), 'utf8');
  const r = checkAbapSource(src);
  const props = r.findings.filter((x) => x.type === 'unknown-property').map((x) => x.member);
  assert(props.join(',') === 'typo2,typo5',
    `directives: only the unwaived typos survive (got ${props.join(',') || 'none'})`);

  const { parseDirectives, applyDirectives } = await import('../lib/findings.mjs');
  assert(parseDirectives('nothing to see here') === null,
    'directives: a source without a directive costs nothing');
  const d = parseDirectives('" abap2ui5lint-disable-next-line duplicate-id\nx\ny');
  assert(d.suppresses(2, 'duplicate-id') && !d.suppresses(2, 'unknown-control') && !d.suppresses(3, 'duplicate-id'),
    'directives: -disable-next-line is scoped to the next line and to the named rule');
  const all = parseDirectives('<!-- abap2ui5lint-disable-next-line -->\nx');
  assert(all.suppresses(2, 'anything'), 'directives: an XML comment without a rule id waives every rule');
  const reason = parseDirectives('" abap2ui5lint-disable-line duplicate-id -- known, tracked in #42');
  assert(reason.suppresses(1, 'duplicate-id') && !reason.suppresses(1, 'known'),
    'directives: the reason after -- is not read as a rule id');
  assert(applyDirectives([{ type: 'duplicate-id' }], '" abap2ui5lint-disable\n').length === 1,
    'directives: a finding the gate could not place is never suppressed');
}

// -------------------------------------------------------------- new rules ----
// display-root-mismatch, binding-type-mismatch, event-arg-out-of-range
{
  const { checkAbapRules } = await import('../lib/abap-rules.mjs');
  const roots = checkAbapSource(fs.readFileSync(f('roots.clas.abap'), 'utf8'));
  const mismatches = roots.findings.filter((x) => x.type === 'display-root-mismatch');
  assert(mismatches.length === 2,
    `display-root-mismatch: both directions reported (got ${mismatches.length})`);
  assert(mismatches.some((x) => x.member === 'popup_display' && x.value === 'mvc:View'),
    'display-root-mismatch: a mvc:View handed to the popup slot');
  assert(mismatches.some((x) => x.member === 'view_display' && x.value === 'core:FragmentDefinition'),
    'display-root-mismatch: a core:FragmentDefinition handed to the view slot');
  assert(!checkAbapSource(fs.readFileSync(f('good.clas.abap'), 'utf8')).findings
    .some((x) => x.type === 'display-root-mismatch'),
    'display-root-mismatch: a matching pair is not reported');

  const typed = checkAbapSource(fs.readFileSync(f('typedbind.clas.abap'), 'utf8'));
  const mism = typed.findings.filter((x) => x.type === 'binding-type-mismatch');
  assert(mism.map((x) => x.memberType).sort().join() === 'boolean,float,int',
    `binding-type-mismatch: a TYPE string field on a float, an int and a boolean property (got ${mism.map((x) => x.memberType).join() || 'none'})`);
  assert(!mism.some((x) => x.value === 'REAL_NUM'),
    'binding-type-mismatch: a numeric ABAP type on a numeric property is not reported');

  const arity = typed.findings.filter((x) => x.type === 'event-arg-out-of-range');
  assert(arity.length === 2, `event-arg-out-of-range: two reads past the end (got ${arity.length})`);
  assert(arity.some((x) => x.value === 'PICK' && x.member === '2' && x.count === 1),
    'event-arg-out-of-range: arg 2 of an event that sends one');
  assert(arity.some((x) => x.value === 'PLAIN' && x.member === '1' && x.count === 0),
    'event-arg-out-of-range: the default arg of an event that sends none');
  assert(!arity.some((x) => x.member === '1' && x.value === 'PICK'),
    'event-arg-out-of-range: a read inside the declared arity is not reported');

  // the two shapes that were false positives on the corpus
  const foreign = `CLASS x IMPLEMENTATION.
  METHOD main.
    DATA(v) = z2ui5_cl_ai_xml=>factory( ).
    v->leaf( \`Button\` )->a( n = \`press\` v = client->_event( \`GO\` ) ).
    CASE client->get_event( ).
      WHEN \`GO\`.
        client->message_box_display( onclose = \`CLOSED\` ).
      WHEN \`CLOSED\`.
        IF client->get_event_arg( ) = \`YES\`.
        ENDIF.
    ENDCASE.
  ENDMETHOD.
  METHOD other.
    client->popover_display( by_id = client->get_event_arg( ) ).
  ENDMETHOD.
ENDCLASS.`;
  const none = checkAbapRules(foreign).filter((x) => x.type === 'event-arg-out-of-range');
  assert(none.length === 0,
    `event-arg-out-of-range: an event the class does not raise, and a read in another method, are not judged (got ${none.length})`);

  // --- an imperative setter where the control has a bindable property -------
  const setters = checkAbapSource(fs.readFileSync(f('setters.clas.abap'), 'utf8'))
    .findings.filter((x) => x.type === 'settable-property-via-action');
  assert(setters.length === 1 && setters[0].member === 'expanded' && setters[0].control === 'sap.m.Panel',
    `settable-property-via-action: only the bindable property is reported (got ${setters.map((x) => `${x.control}.${x.member}`).join() || 'none'})`);
  assert(!setters.some((x) => x.member === 'selectedSection'),
    'settable-property-via-action: an association cannot be bound and is never reported');
  assert(!setters.some((x) => x.member === 'asyncURLHandler'),
    'settable-property-via-action: a function-typed property cannot travel in a JSON model');

  // --- a relative binding with no context to resolve against ----------------
  const orphan = checkAbapSource(fs.readFileSync(f('orphanbind.clas.abap'), 'utf8'))
    .findings.filter((x) => x.type === 'relative-binding-without-context');
  assert(orphan.length === 1 && orphan[0].value === 'NAME',
    `relative-binding-without-context: only the contextless root field is reported (got ${orphan.map((x) => x.value).join() || 'none'})`);
  assert(!checkAbapSource(fs.readFileSync(f('rowpaths.clas.abap'), 'utf8'))
    .findings.some((x) => x.type === 'relative-binding-without-context'),
    'relative-binding-without-context: a relative binding inside a bound aggregation is not judged');

  // --- CONTROL_BY_ID against the ids the class actually declares ------------
  const ids = checkAbapRules(fs.readFileSync(f('actionid.clas.abap'), 'utf8'))
    .filter((x) => x.type === 'frontend-action-unknown-id');
  assert(ids.length === 1 && ids[0].value === 'messageview',
    `frontend-action-unknown-id: only the miscased id is reported (got ${ids.map((x) => x.value).join() || 'none'})`);
  assert(ids[0].allowed.sort().join() === 'mainPage,messageView',
    `frontend-action-unknown-id: the finding carries the declared ids (got ${ids[0].allowed.join()})`);
  assert(checkAbapRules(`
    DATA(v) = z2ui5_cl_ai_xml=>factory( ).
    v->leaf( \`Page\` )->a( n = \`id\` v = |page{ idx }| ).
    client->follow_up_action( val = client->cs_event-control_by_id
                              t_arg = VALUE #( ( \`page1\` ) ( \`focus\` ) ) ).`)
    .filter((x) => x.type === 'frontend-action-unknown-id').length === 0,
    'frontend-action-unknown-id: a class that builds ids at runtime is not judged');
  assert(checkAbapRules(fs.readFileSync(f('wire.clas.abap'), 'utf8'))
    .filter((x) => x.type === 'frontend-action-unknown-id').length === 0,
    'frontend-action-unknown-id: a class whose views declare no id at all is not judged');

  // --- date/time model types over a JSON model ------------------------------
  const dates = checkAbapSource(fs.readFileSync(f('datetype.clas.abap'), 'utf8'));
  const noSource = dates.findings.filter((x) => x.type === 'date-type-without-source');
  assert(noSource.length === 3,
    `date-type-without-source: three sourceless date bindings (got ${noSource.length})`);
  assert(noSource.map((x) => x.value).sort().join() === 'DateType,TimeType,sap.ui.model.type.DateTime',
    `date-type-without-source: the alias and the full module name are both judged (got ${noSource.map((x) => x.value).sort().join()})`);
  assert(!dates.findings.some((x) => x.type === 'date-type-without-source' && x.value === 'sap.ui.model.type.Float'),
    'date-type-without-source: a non-date type never needs a source format');

  // --- frontend-action wires and CSS braces ---------------------------------
  const wire = checkAbapSource(fs.readFileSync(f('wire.clas.abap'), 'utf8'));
  const actions = wire.findings.filter((x) => x.type === 'invalid-frontend-action');
  assert(actions.length === 4, `invalid-frontend-action: four bad wires (got ${actions.length})`);
  assert(actions.some((x) => x.control === 'CONTROL_GLOBAL' && x.value === 'MESSAGE_TOASTER' && x.member === 'global object'),
    'invalid-frontend-action: an unknown global object');
  assert(actions.some((x) => x.control === 'CONTROL_GLOBAL' && x.value === 'display' && x.allowed.join() === 'show'),
    'invalid-frontend-action: a method the global does not offer, with its allowed set');
  assert(actions.some((x) => x.control === 'BINDING_CALL' && x.value === 'refresh'),
    'invalid-frontend-action: a binding method that is not filter or sort');
  assert(actions.some((x) => x.member === 'view slot'),
    'invalid-frontend-action: the obsolete empty view slot of CONTROL_BY_ID');
  assert(!actions.some((x) => ['MESSAGE_TOAST', 'show', 'hide', 'BUSY_INDICATOR'].includes(x.value)),
    'invalid-frontend-action: a correct wire is never reported');

  const { ACTION_ARGS, GLOBAL_TARGETS } = await import('../lib/frontend-actions.mjs');
  assert(Object.keys(ACTION_ARGS).every((a) => a === a.toLowerCase()) && GLOBAL_TARGETS.MESSAGE_TOAST.includes('show'),
    'invalid-frontend-action: the catalog is keyed by the cs_event constant name');
  assert(checkAbapRules('client->follow_up_action( val = client->cs_event-control_global '
    + 't_arg = VALUE #( ( `POPUP` ) ( `setWithinArea` ) ( `withinArea` ) ) ).')
    .filter((x) => x.type === 'invalid-frontend-action').length === 0,
    'invalid-frontend-action: POPUP.setWithinArea is a known global (abap2UI5 CONTROL_GLOBAL target)');

  const css = wire.findings.filter((x) => x.type === 'unescaped-brace-in-style');
  assert(css.length === 1 && css[0].count === 2,
    `unescaped-brace-in-style: one finding per stylesheet, counting its braces (got ${css.length}/${css[0]?.count})`);
  assert(checkAbapRules('DATA(c) = `<style>.a \\{color:red\\}</style>`.').length === 0,
    'unescaped-brace-in-style: a correctly escaped stylesheet is silent');
  assert(checkAbapRules('DATA(c) = `<style>.a \\{x\\}</style>` && `toast {0} done`.')
    .filter((x) => x.type === 'unescaped-brace-in-style').length === 0,
    'unescaped-brace-in-style: a brace outside the <style> span is not CSS (the corpus false positive)');

  const collapsed = wire.findings.filter((x) => x.type === 'collapsed-brace-in-style');
  assert(collapsed.length === 1 && collapsed[0].count === 2,
    `collapsed-brace-in-style: the template form is caught where the source looks escaped (got ${collapsed.length})`);
  assert(checkAbapRules('DATA(c) = |<style>.a \\\\\\{x\\\\\\}</style>|.')
    .filter((x) => x.type === 'collapsed-brace-in-style').length === 0,
    'collapsed-brace-in-style: a doubled backslash survives the template and is not reported');
  assert(checkAbapRules('DATA(c) = `<style>.a \\{x\\}</style>`.')
    .filter((x) => x.type === 'collapsed-brace-in-style').length === 0,
    'collapsed-brace-in-style: the backtick form it recommends is not reported');

  const dead = wire.findings.filter((x) => x.type === 'unused-public-attribute');
  assert(dead.length === 1 && dead[0].member === 'ballast',
    `unused-public-attribute: only the untouched one (got ${dead.map((x) => x.member).join() || 'none'})`);
  assert(!dead.some((x) => ['name', 'counter'].includes(x.member)),
    'unused-public-attribute: a bound attribute and one used only in code are both left alone');
  assert(checkAbapRules('CLASS x DEFINITION. PROTECTED SECTION. DATA hidden TYPE string. ENDCLASS.')
    .filter((x) => x.type === 'unused-public-attribute').length === 0,
    'unused-public-attribute: a non-PUBLIC attribute is not transported and not judged');
}

// ------------------------------------------- rules distilled from the corpus ----
// popover-display-val, uncurated-formatter, hardcoded-binding-path,
// duplicate-for-iterator — lessons that bit the ai-demokit corpus, promoted
// from its repo-local pattern-lint into rules every consumer sees
{
  const { checkAbapRules } = await import('../lib/abap-rules.mjs');
  const { applyFixes } = await import('../lib/fix.mjs');
  const srcC = fs.readFileSync(f('corpusrules.clas.abap'), 'utf8');
  const corpus = checkAbapSource(srcC);
  const hasC = (t, pred = () => true) => corpus.findings.some((x) => x.type === t && pred(x));

  assert(hasC('popover-display-val'),
    'popover-display-val: val = on popover_display is reported (it does not compile)');
  const pop = corpus.findings.find((x) => x.type === 'popover-display-val');
  assert(/popover_display\( xml = popover/.test(applyFixes(srcC, [pop]).output),
    'popover-display-val: --fix rewrites the parameter name to xml, the argument untouched');
  assert(!checkAbapRules('client->popup_display( val = popup->stringify( ) ).')
    .some((x) => x.type === 'popover-display-val'),
    'popover-display-val: popup_display( val = ) is the correct form and never reported');

  assert(hasC('uncurated-formatter', (x) => x.value === 'round2DP' && x.member === 'number'),
    'uncurated-formatter: a formatter outside the curated module is reported');
  assert(!hasC('uncurated-formatter', (x) => x.value === 'DateCreateObject'),
    'uncurated-formatter: a curated formatter is not');
  const ownModule = checkAbapSource(`
  DATA(view) = z2ui5_cl_ai_xml=>factory( ).
  view->open( n = \`View\` ns = \`mvc\`
      )->a( n = \`xmlns\`      v = \`sap.m\`
      )->a( n = \`xmlns:mvc\`  v = \`sap.ui.core.mvc\`
      )->a( n = \`xmlns:core\` v = \`sap.ui.core\`
      )->a( n = \`core:require\` v = \`{Formatter: 'my/app/formatter'}\`
      )->leaf( \`Text\` )->a( n = \`text\` v = \`{ path: 'X', formatter: 'Formatter.myOwn' }\` ).
  client->view_display( view->stringify( ) ).`);
  assert(!ownModule.findings.some((x) => x.type === 'uncurated-formatter'),
    'uncurated-formatter: an alias pointed at the class\'s own module is not judged');

  assert(hasC('hardcoded-binding-path', (x) => x.value.includes('{/TITLE}')),
    'hardcoded-binding-path: a textual absolute path is reported');
  assert(!hasC('hardcoded-binding-path', (x) => x.value.includes('PRICE')),
    'hardcoded-binding-path: a relative complex-binding path is not absolute and not reported');
  assert(!checkAbapRules(`client->switch_default_model_path( ).
    view->leaf( \`Panel\` )->a( n = \`binding\` v = \`{/Products('4711')}\` ).`)
    .some((x) => x.type === 'hardcoded-binding-path'),
    'hardcoded-binding-path: an OData entity path with a key predicate is exempt when the class switches its default model');
  assert(!checkAbapRules('DATA(css) = `<style>.a \\{/* keep */color:red\\}</style>`.')
    .some((x) => x.type === 'hardcoded-binding-path'),
    'hardcoded-binding-path: a CSS comment after a brace inside <style> is not a path');

  assert(hasC('duplicate-for-iterator', (x) => x.member === 'i'),
    'duplicate-for-iterator: the reused iterator across two VALUE blocks in one method');
  assert(!checkAbapRules('METHOD a. x = VALUE #( FOR i = 1 UNTIL i > 2 ( ) ). ENDMETHOD.'
    + ' METHOD b. y = VALUE #( FOR i = 1 UNTIL i > 2 ( ) ). ENDMETHOD.')
    .some((x) => x.type === 'duplicate-for-iterator'),
    'duplicate-for-iterator: the same name in two different methods is fine');
}

// --------------------------------------------------------- lifecycle rules ----
{
  const lc = checkAbapSource(fs.readFileSync(f('lifecycle.clas.abap'), 'utf8'));
  assert(lc.findings.some((x) => x.type === 'separate-lifecycle-ifs' && x.member === 'check_on_navigated'),
    'separate-lifecycle-ifs: a second plain IF on a lifecycle check is reported');
  assert(lc.findings.some((x) => x.type === 'missing-view-display-on-navigated'),
    'missing-view-display-on-navigated: a navigated branch that never re-displays');

  const chained = `METHOD z2ui5_if_app~main.
    IF client->check_on_init( ).
      client->view_display( render( ) ).
    ELSEIF client->check_on_navigated( ).
      IF picked IS INITIAL.
        picked = \`x\`.
      ENDIF.
      client->view_display( render( ) ).
    ENDIF.
  ENDMETHOD.`;
  const { checkAbapRules } = await import('../lib/abap-rules.mjs');
  assert(!checkAbapRules(chained).some((x) => x.type === 'separate-lifecycle-ifs'),
    'separate-lifecycle-ifs: an IF/ELSEIF chain is the correct form and not reported');
  assert(!checkAbapRules(chained).some((x) => x.type === 'missing-view-display-on-navigated'),
    'missing-view-display-on-navigated: an inner IF does not end the branch early — the display after it counts');
  // the guard idiom is exclusive by construction: good.clas.abap opens with
  // `IF check_on_event( \`GO\` ). RETURN. ENDIF.` before its init IF
  assert(!checkAbapSource(fs.readFileSync(f('good.clas.abap'), 'utf8')).findings
    .some((x) => x.type === 'separate-lifecycle-ifs'),
    'separate-lifecycle-ifs: an IF block that RETURNs (the guard idiom) does not count');
}

// -------------------------------- event-parameter existence + closed gaps ----
{
  const paramFindings = (control, event, param, type) => checkAbapSource(`
  DATA(view) = z2ui5_cl_ai_xml=>factory( ).
  view->open( n = \`View\` ns = \`mvc\`
      )->a( n = \`xmlns\`     v = \`sap.m\`
      )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
      )->leaf( \`${control}\`
          )->a( n = \`${event}\` v = client->_event( val = \`GO\` t_arg = VALUE #( ( \`\${$parameters>/${param}}\` ) ) ) ).
  client->view_display( view->stringify( ) ).`)
    .findings.filter((x) => x.type === type);

  const typo = paramFindings('SearchField', 'search', 'quer', 'unknown-event-parameter');
  assert(typo.length === 1 && typo[0].allowed.includes('query'),
    'unknown event param: a typo is reported, carrying the names the event does declare');
  assert(!paramFindings('SearchField', 'search', 'query', 'unknown-event-parameter').length,
    'unknown event param: a declared parameter without @since is known, not unknown');
  assert(!paramFindings('Button', 'press', 'anything', 'unknown-event-parameter').length,
    'unknown event param: an event that declares no parameters block is never judged');
  assert(paramFindings('SearchField', 'search', 'searchButtonPressed', 'event-parameter-too-new').length === 1
    && !paramFindings('SearchField', 'search', 'searchButtonPressed', 'unknown-event-parameter').length,
    'unknown event param: a too-new parameter reports as too-new, never doubly as unknown');
  // the false positive the first corpus run produced: a subclass widening an
  // inherited event without redeclaring it (DateRangeSelection change from/to)
  assert(!paramFindings('DateRangeSelection', 'change', 'from', 'unknown-event-parameter').length,
    'unknown event param: an event the control does not declare itself is not judged');

  // --- the two rules that only had negative/severity assertions -------------
  const tooNew = checkAbapSource(view('  )->leaf( `IllustratedMessage` )')).findings
    .filter((x) => x.type === 'control-too-new');
  assert(tooNew.length === 1 && tooNew[0].control === 'sap.m.IllustratedMessage' && tooNew[0].since === '1.98',
    `control-too-new: a control introduced after the floor is reported with its @since (got ${tooNew.map((x) => `${x.control}@${x.since}`).join() || 'none'})`);

  const brokenExpr = checkAbapSource(view('  )->leaf( `Button` )->a( n = `visible` v = `{= ( 1 }` )')).findings
    .filter((x) => x.type === 'invalid-expression-binding');
  assert(brokenExpr.length === 1 && brokenExpr[0].member === 'visible',
    'invalid-expression-binding: unbalanced parens in {= … } are reported');

  // missing-required-aggregation reaches subclasses through the chain — the
  // REQUIRED_WITH table needs no TreeTable row of its own
  const tree = checkAbapSource(`
  DATA(v) = z2ui5_cl_ai_xml=>factory( ).
  v->open( n = \`View\` ns = \`mvc\`
      )->a( n = \`xmlns\`       v = \`sap.m\`
      )->a( n = \`xmlns:mvc\`   v = \`sap.ui.core.mvc\`
      )->a( n = \`xmlns:table\` v = \`sap.ui.table\`
      )->open( n = \`TreeTable\` ns = \`table\` )->a( n = \`rows\` v = \`{/T_X}\` ).
  client->view_display( v->stringify( ) ).`);
  assert(tree.findings.some((x) => x.type === 'missing-required-aggregation' && x.member === 'columns'),
    'missing-required-aggregation: a TreeTable inherits the Table rows→columns rule through the chain');
}

// ------------------------------------------- rules['render-error'] ----
// the render gate's pseudo-rule: waive or downgrade render failures per file
// instead of switching the gate off wholesale
{
  const waived = (await checkFiles([f('broken.clas.abap')], { rules: { 'render-error': { exclude: ['broken'] } } }))[0];
  assert(waived.renderErrors.length === 0 && waived.notes.some((n) => /waived by rules\['render-error'\]/.test(n)),
    'render-error: an exclude waives the render failures of a matching file, saying so in a note');

  const downgraded = (await checkFiles([f('broken.clas.abap')], { rules: { 'render-error': 'warning' } }))[0];
  assert(downgraded.renderErrors.length > 0 && downgraded.renderSeverity === 'warning',
    'render-error: a severity override keeps the errors and re-weighs them');
  const { problemsOf } = await import('../lib/report.mjs');
  assert(problemsOf(downgraded).filter((p) => p.rule === 'render-error').every((p) => p.severity === 'warning'),
    'render-error: the report carries the overridden severity');

  const stale = (await checkFiles([f('good.clas.abap')], { rules: { 'render-error': { exclude: ['good'] } } }))[0];
  assert(stale.notes.some((n) => /stale render-error waiver/.test(n)),
    'render-error: a waived file that renders clean is called out as a stale waiver');

  const os = await import('node:os');
  const { loadConfig } = await import('../lib/config.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5render-'));
  const cfg = path.join(dir, 'abap2ui5lint.jsonc');
  fs.writeFileSync(cfg, '{"rules": {"render-error": {"exclude": ["legacy/"]}}}');
  assert(loadConfig(cfg).rules['render-error'].exclude[0] === 'legacy/',
    'render-error: the config accepts the pseudo-rule in its rules block');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------- curated formatter mirror ----
// the render harness provides the same formatter surface the rule judges by —
// the demo-kit pack was removed upstream, and a harness still mirroring it
// would render views green that break live
{
  const { CURATED_FORMATTERS } = await import('../lib/formatters.mjs');
  const renderSrc = fs.readFileSync(path.join(FIX, '..', '..', 'lib', 'render.mjs'), 'utf8');
  const mirrored = [...renderSrc.matchAll(/^ {6}(\w+): function/gm)].map((m) => m[1]);
  assert(mirrored.sort().join() === [...CURATED_FORMATTERS].sort().join(),
    `formatters: the render harness mirrors exactly the curated set (harness: ${mirrored.join(', ') || 'none'})`);
}

// ------------------------------------------------ round 2: new rules ----
{
  const { checkAbapRules } = await import('../lib/abap-rules.mjs');

  // --- binding-to-nonpublic: the app-043 failure class ----------------------
  const nonpublic = `CLASS zcl_x DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA title TYPE string.
  PROTECTED SECTION.
    DATA expanded TYPE abap_bool.
ENDCLASS.
CLASS zcl_x IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA(lv_tmp) = \`x\`.
    DATA(v) = z2ui5_cl_ai_xml=>factory( ).
    v->open( n = \`View\` ns = \`mvc\` )->a( n = \`xmlns\` v = \`sap.m\` )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
      )->open( \`Panel\`
        )->a( n = \`headerText\` v = client->_bind( title )
        )->a( n = \`expanded\`   v = client->_bind( expanded ) ).
    client->view_display( v->stringify( ) ).
  ENDMETHOD.
ENDCLASS.`;
  const np = checkAbapRules(nonpublic).filter((x) => x.type === 'binding-to-nonpublic');
  assert(np.length === 1 && np[0].member === 'expanded',
    `binding-to-nonpublic: a PROTECTED attribute bound is reported, a PUBLIC one is not (got ${np.map((x) => x.member).join() || 'none'})`);
  assert(!checkAbapRules(fs.readFileSync(f('abaprules.clas.abap'), 'utf8'))
    .some((x) => x.type === 'binding-to-nonpublic'),
    'binding-to-nonpublic: a bound LOCAL stays binding-to-local, never nonpublic');

  // --- private UI5 internals + the commercial host --------------------------
  const internals = checkAbapRules('lv_js = `oControl.mProperties.text` && `sap.ui.getCore()`.');
  assert(internals.some((x) => x.type === 'ui5-internal-access' && x.value === 'mProperties'),
    'ui5-internal-access: reading mProperties is reported');
  assert(checkAbapRules('client->_event( `X` ).').every((x) => x.type !== 'ui5-internal-access'),
    'ui5-internal-access: a class without internals access is silent');
  const host = checkAbapRules('url = `https://ui5.sap.com/resources/sap-ui-core.js`.');
  assert(host.some((x) => x.type === 'commercial-ui5-host' && x.value === 'ui5.sap.com'),
    'commercial-ui5-host: the commercial host is reported');
  assert(!checkAbapRules('url = `https://sdk.openui5.org/resources/sap-ui-core.js`.')
    .some((x) => x.type === 'commercial-ui5-host'),
    'commercial-ui5-host: sdk.openui5.org is the sanctioned host');

  // --- enum VALUES carry their own @since now -------------------------------
  const critical = (minUi5) => checkAbapSource(view('  )->leaf( `Button` )->a( n = `type` v = `Critical` )'), { minUi5 })
    .findings.filter((x) => x.type === 'enum-value-too-new');
  assert(critical('1.71').length === 1 && critical('1.71')[0].since === '1.73',
    `enum-value-too-new: ButtonType.Critical (@1.73) is reported on a 1.71 target (got ${critical('1.71').map((x) => x.since).join() || 'none'})`);
  assert(!critical('1.150').length,
    'enum-value-too-new: the same value is fine once the target reaches its @since');
  assert(!checkAbapSource(view('  )->leaf( `Button` )->a( n = `type` v = `Emphasized` )'))
    .findings.some((x) => x.type === 'enum-value-too-new'),
    'enum-value-too-new: a value that predates version tracking is never reported');

  // --- absolute paths inside complex bindings and expressions ---------------
  const complexSrc = (value) => `CLASS zcl_x DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES: BEGIN OF ty_s_row, text TYPE string, END OF ty_s_row.
    DATA t_x TYPE STANDARD TABLE OF ty_s_row.
    DATA name TYPE string.
ENDCLASS.
CLASS zcl_x IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    t_x = VALUE #( ( text = \`a\` ) ).
    name = \`n\`.
    DATA(v) = z2ui5_cl_ai_xml=>factory( ).
    v->open( n = \`View\` ns = \`mvc\` )->a( n = \`xmlns\` v = \`sap.m\` )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
      )->open( \`List\` )->a( n = \`items\` v = client->_bind( t_x )
      )->a( n = \`tooltip\` v = client->_bind( name )
      )->leaf( \`Text\` )->a( n = \`text\` v = ${value} ).
    client->view_display( v->stringify( ) ).
  ENDMETHOD.
ENDCLASS.`;
  const complexPaths = (value) => checkAbapSource(complexSrc(value))
    .findings.filter((x) => x.type === 'unknown-binding-path');
  assert(complexPaths('|\\{ path: \'/TYPO\', type: \'sap.ui.model.type.String\' \\}|').some((x) => x.value === '/TYPO'),
    'complex paths: a hardcoded absolute path in a binding info is existence-checked now');
  assert(complexPaths('`{= ${/NOPE} + 1 }`').some((x) => x.value === '/NOPE'),
    'complex paths: an absolute path inside an expression binding too');
  assert(!complexPaths('`{= ${/T_X/9/TEXT} }`').length,
    'complex paths: a numeric row index steps into the array — the corpus false positive');
  assert(!complexPaths('|\\{ path: \'/NAME\' \\}|').length,
    'complex paths: a path the model has is not reported');

  // --- undeclared-namespace gained a fix for conventional prefixes ----------
  const { applyFixes } = await import('../lib/fix.mjs');
  const nsSrc = `
  DATA(v) = z2ui5_cl_ai_xml=>factory( ).
  v->open( n = \`View\` ns = \`mvc\`
      )->a( n = \`xmlns\`     v = \`sap.m\`
      )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
      )->leaf( n = \`Icon\` ns = \`core\` )->a( n = \`src\` v = \`sap-icon://add\` ).
  client->view_display( v->stringify( ) ).`;
  const nsFinding = checkAbapSource(nsSrc).findings.find((x) => x.type === 'undeclared-namespace');
  assert(nsFinding?.fixes?.length === 1,
    'undeclared-namespace: a conventional prefix carries a fix');
  assert(/->a\( n = `xmlns:core` v = `sap\.ui\.core` \)->a\( n = `xmlns`/.test(applyFixes(nsSrc, [nsFinding]).output),
    'undeclared-namespace: the fix inserts the declaration next to the root\'s first xmlns write');
  const vrNs = checkAbapSource(fs.readFileSync(f('viewrules.clas.abap'), 'utf8'))
    .findings.find((x) => x.type === 'undeclared-namespace');
  assert(vrNs && !vrNs.fixes,
    'undeclared-namespace: an unconventional prefix could mean any library and gets no fix');
}

// ------------------------------------------------ sarif + baseline + cli ----
{
  const cp = await import('node:child_process');
  const os = await import('node:os');
  const CLI = path.join(FIX, '..', '..', 'cli.mjs');
  const run = (args, env = {}) => {
    try {
      return { out: cp.execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', GITHUB_ACTIONS: '', ...env } }), code: 0 };
    } catch (e) { return { out: e.stdout ?? '', code: e.status }; }
  };

  // --- sarif ----------------------------------------------------------------
  const sarif = JSON.parse(run([f('viewrules.clas.abap'), '--no-render', '--format', 'sarif'], { GITHUB_ACTIONS: 'true' }).out);
  assert(sarif.version === '2.1.0' && sarif.runs[0].tool.driver.name === 'abap2ui5-linter',
    'sarif: a parseable 2.1.0 log, even inside GitHub Actions (no annotations join it)');
  assert(sarif.runs[0].results.some((r) => r.ruleId === 'duplicate-id' && r.level === 'error')
    && sarif.runs[0].results.some((r) => r.level === 'note'),
    'sarif: severities map to error/warning/note and every result carries its rule id');
  assert(sarif.runs[0].tool.driver.rules.every((r) => r.helpUri.includes(`#${r.id}`)),
    'sarif: every rule links to its anchor on the rules page');

  // --- baseline -------------------------------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5base-'));
  const target = path.join(dir, 'abaprules.clas.abap');
  fs.copyFileSync(f('abaprules.clas.abap'), target);
  const bl = path.join(dir, 'abap2ui5lint-baseline.json');

  assert(run([target, '--no-render', '--baseline', bl, '--update-baseline']).code === 0
    && fs.existsSync(bl),
    'baseline: --update-baseline freezes the current findings and exits 0');
  const adopted = run([target, '--no-render', '--baseline', bl]);
  assert(adopted.code === 0 && /suppressed by/.test(adopted.out),
    `baseline: a run over unchanged findings is green and says what it suppressed (exit ${adopted.code})`);

  const withNew = fs.readFileSync(target, 'utf8')
    .replace('client->view_display', 'client->popover_display( val = view->stringify( ) ).\n    client->view_display');
  fs.writeFileSync(target, withNew);
  const newFinding = run([target, '--no-render', '--baseline', bl]);
  assert(newFinding.code === 1 && /popover-display-val/.test(newFinding.out)
    && !/obsolete-binder/.test(newFinding.out.split('\n').filter((l) => /error|warning/.test(l)).join('\n')),
    'baseline: a NEW finding fails while the frozen ones stay suppressed');

  fs.copyFileSync(f('good.clas.abap'), target);
  const stale = run([target, '--no-render', '--baseline', bl]);
  assert(stale.code === 1 && /STALE/.test(stale.out),
    'baseline: an entry whose finding is gone is stale and FAILS — a suppression never outlives its finding');

  // --- --fix-dry-run --------------------------------------------------------
  fs.copyFileSync(f('abaprules.clas.abap'), target);
  const before = fs.readFileSync(target, 'utf8');
  assert(/would fix/.test(run([target, '--no-render', '--fix-dry-run']).out)
    && fs.readFileSync(target, 'utf8') === before,
    'fix: --fix-dry-run reports without writing (the env variable keeps working too)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------- upstream mirror parsers ----
{
  const { embeddedJs, parseGlobalTargets, parseFormatterExports } = await import('../scripts/check-upstream.mjs');
  const abap = 'x = `const GLOBAL_TARGETS = {` && |\\n| &&\n'
    + '`  ONE_LINER: { get: () => X, methods: { show: ["string"] } },` && |\\n| &&\n'
    + '`  MULTI: {` && |\\n| && `    get: () => Y,` && |\\n| && `    methods: {` && |\\n| &&\n'
    + '`      a: ["int"],` && |\\n| && `      b: [],` && |\\n| && `    },` && |\\n| && `  },` && |\\n| && `};`.';
  const targets = parseGlobalTargets(abap);
  assert(targets.ONE_LINER?.join() === 'show' && targets.MULTI?.join() === 'a,b',
    `upstream: GLOBAL_TARGETS parses one-line and multi-line entries (got ${JSON.stringify(targets)})`);
  assert(embeddedJs('a = `line1` && |\\n| && `line2`.').includes('line1\nline2'),
    'upstream: the embedded JS is reassembled from the backtick literals');
  assert(parseFormatterExports('  return {\n    DateCreateObject(s) {\n      return s;\n    },\n    expandInlineIcons(text) {},\n  };').join() === 'DateCreateObject,expandInlineIcons',
    'upstream: the formatter export surface parses');
}

// ------------------------------------------------- metadata drift gate ----
// generate-metadata --check took ~3 minutes before the extend-scan fix and
// lived in its own CI step; at ~2 seconds it belongs in the suite
{
  const cp = await import('node:child_process');
  let ok = true;
  let msg = '';
  try {
    cp.execFileSync('node', [path.join(FIX, '..', '..', 'scripts', 'generate-metadata.mjs'), '--check'], { encoding: 'utf8' });
  } catch (e) { ok = false; msg = (e.stderr || e.stdout || '').trim(); }
  assert(ok, `metadata: data/properties.json is in sync — npm run generate-metadata (${msg})`);
}

// ------------------------------------------------------------------- fix ----
{
  const os = await import('node:os');
  const cp = await import('node:child_process');
  const CLI = path.join(FIX, '..', '..', 'cli.mjs');
  const { applyFixes } = await import('../lib/fix.mjs');
  const { checkAbapRules } = await import('../lib/abap-rules.mjs');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5fix-'));
  const target = path.join(dir, 'abaprules.clas.abap');
  const original = fs.readFileSync(f('abaprules.clas.abap'), 'utf8');
  fs.writeFileSync(target, original);

  // the linter still exits 1 on what is left over, so never trust execFileSync
  const run = (env = {}) => {
    try {
      return cp.execFileSync('node', [CLI, target, '--no-render', '--fix'], {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1', GITHUB_ACTIONS: '', ...env },
      });
    } catch (e) { return e.stdout ?? ''; }
  };

  const dry = run({ ABAP2UI5LINT_FIX_DRY_RUN: 'true' });
  assert(/would fix 3 problem\(s\)/.test(dry) && fs.readFileSync(target, 'utf8') === original,
    'fix: the dry run reports what it would do and leaves the file alone');

  const out = run();
  const fixed = fs.readFileSync(target, 'utf8');
  assert(/fixed 3 problem\(s\) in 1 file\(s\)/.test(out), 'fix: the three mechanical corrections are applied');
  assert(/client->_bind\( name \)/.test(fixed) && !/_bind_edit/.test(fixed),
    'fix: obsolete-binder becomes client->_bind( )');
  assert(/z2ui5_cl_ai_xml=>as_bool\( abap_true \)/.test(fixed),
    'fix: unconverted-abap-boolean is wrapped, the token kept verbatim');
  assert(/`\$\{BARE_BRACE\}`/.test(fixed) && /`\$\{RESOLVED\}`/.test(fixed) && /`\{0\} selected`/.test(fixed),
    'fix: event-arg-unresolved gains its $, the already-correct and quoted forms untouched');
  assert(!/obsolete-binder|unconverted-abap-boolean|event-arg-unresolved/.test(out),
    'fix: what was fixed is gone from the report of the same run');
  assert(/binding-to-local/.test(out), 'fix: a finding without a mechanical correction survives');

  const twice = original.replace(/client->_bind\( lv_local \)/, 'client->_bind_edit( lv_local )');
  const both = checkAbapRules(twice).find((x) => x.type === 'obsolete-binder');
  assert(both.fixes.length === 2, 'fix: two call sites of one deduped finding both carry a fix');
  assert(!/_bind_edit/.test(applyFixes(twice, [both]).output), 'fix: and both are applied in one pass');

  const overlap = applyFixes('abcdef', [{ fixes: [{ start: 1, end: 4, text: 'X' }, { start: 2, end: 5, text: 'Y' }] }]);
  assert(overlap.output === 'aXef' && overlap.applied === 1 && overlap.deferred === 1,
    'fix: overlapping spans are deferred to the next run, never merged by guesswork');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- report ----
{
  const cp = await import('node:child_process');
  const CLI = path.join(FIX, '..', '..', 'cli.mjs');
  // GITHUB_ACTIONS is pinned OFF: inherited from the runner it turns the
  // annotations on for every case below, and the assertions would then be
  // testing a different program in CI than they test locally
  const run = (args, env = {}) => {
    try {
      return cp.execFileSync('node', [CLI, ...args], {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1', GITHUB_ACTIONS: '', ...env },
      });
    } catch (e) { return e.stdout ?? ''; }
  };
  const dumps = f('dumps.clas.abap');

  const stylish = run([dumps, '--no-render']);
  assert(/duplicate-property\s*$/m.test(stylish), 'report: every line ends in its rule id');
  assert(/^2 problems \(2 errors, 0 warnings, 0 hints\)$/m.test(stylish), 'report: the problem count reads like ui5lint');
  assert(!/\bpass\b/.test(run([f('good.clas.abap'), '--no-render'])) &&
    /Success! No findings detected\./.test(run([f('good.clas.abap'), '--no-render'])),
    'report: a clean file is not printed, only the success line');

  const quiet = run([f('viewrules.clas.abap'), '--no-render', '--quiet']);
  assert(!/\bhint\b.*missing-accessibility/.test(quiet) && /2 hints\)/.test(quiet),
    'report: --quiet hides the non-errors but still counts them');

  const json = JSON.parse(run([dumps, '--no-render', '--json']));
  assert(json.problems === 2 && json.totals.error === 2 && json.results[0].findings[0].type,
    'report: --json carries totals, problems and the annotated findings');
  assert(JSON.parse(run([dumps, '--no-render', '--format', 'json'])).problems === 2,
    'report: --format json is the same thing');

  const md = run([dumps, '--no-render', '--format', 'markdown']);
  assert(/\| Location \| Severity \| Message \| Rule \|/.test(md) && /`duplicate-property`/.test(md),
    'report: --format markdown emits a table per file');

  const annotated = run([dumps, '--no-render'], { GITHUB_ACTIONS: 'true' });
  assert(/^::error file=.*dumps\.clas\.abap,line=31,col=18,title=abap2ui5-linter\(duplicate-property\)::/m.test(annotated),
    'report: inside GitHub Actions the findings are annotated onto the diff');
  assert(!/^::/m.test(run([dumps, '--no-render', '--no-annotate'], { GITHUB_ACTIONS: 'true' })),
    'report: --no-annotate switches that off again');
  assert(!/^::/m.test(run([dumps, '--no-render'])), 'report: no annotations outside a workflow');
  // a workflow command appended after the document would make it a parse
  // error - `--json | jq` inside Actions is the case that found this
  const inWorkflow = run([dumps, '--no-render', '--json'], { GITHUB_ACTIONS: 'true' });
  assert(JSON.parse(inWorkflow).problems === 2 && !/^::/m.test(inWorkflow),
    'report: --json stays parseable inside GitHub Actions, annotations do not join it');
  assert(!/^::/m.test(run([dumps, '--no-render', '--format', 'markdown'], { GITHUB_ACTIONS: 'true' })),
    'report: markdown stays clean too');

  assert(/^abap2ui5-linter \d+\.\d+\.\d+ \(.*cli\.mjs\)$/m.test(run(['--version'])),
    'report: --version prints version and script location');
  const fails = (args) => {
    try { cp.execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }); return ''; }
    catch (e) { return e.status === 2 ? (e.stderr ?? '') : ''; }
  };
  assert(/unknown option '--nope'/.test(fails(['--nope'])), 'report: an unknown flag is refused, not read as a path');
  assert(/--allow needs a value/.test(fails([dumps, '--no-render', '--allow'])),
    'report: a flag missing its value is refused instead of crashing the gate');
  assert(/no such file or directory: .*no-such-path/.test(fails(['no-such-path', '--no-render'])),
    'report: a mistyped path is one clean line and exit 2, not a stack trace');
}

// ---------------------------------------------------------------- schema ----
{
  const { render, SCHEMA_FILE } = await import('../scripts/generate-schema.mjs');
  const committed = fs.readFileSync(SCHEMA_FILE, 'utf8');
  assert(committed === render(), 'schema: data/abap2ui5lint.schema.json is in sync (npm run generate-schema)');
  const schema = JSON.parse(committed);
  const { RULES, RENDER_RULE } = await import('../lib/findings.mjs');
  // + 1: the render gate's pseudo-rule is offered in the rules block too
  assert(Object.keys(schema.properties.rules.properties).length === RULES.length + 1
    && RULES.includes('duplicate-id') && schema.properties.rules.properties[RENDER_RULE],
    'schema: every rule id plus the render pseudo-rule is offered to the editor');
}

// ----------------------------------------------------------- rules page ----
{
  const { RULES } = await import('../lib/findings.mjs');
  const { RULE_DOCS, CATEGORIES } = await import('../lib/rule-docs.mjs');
  const { FIXABLE } = await import('../lib/fix.mjs');
  const { buildPage, PAGE_FILE } = await import('../scripts/generate-rules-page.mjs');

  const documented = Object.keys(RULE_DOCS).sort();
  assert(documented.join() === [...RULES].join(),
    `rules page: every rule is documented and every documented rule exists (${
      RULES.filter((r) => !RULE_DOCS[r]).concat(documented.filter((d) => !RULES.includes(d))).join(', ') || 'in sync'})`);

  const known = new Set(CATEGORIES.map((c) => c.id));
  assert(Object.values(RULE_DOCS).every((d) => known.has(d.category) && d.summary && d.detail),
    'rules page: every entry has a known category, a summary and a detail');

  assert(FIXABLE.every((id) => RULES.includes(id) && RULE_DOCS[id].fixNote),
    'rules page: an autofixable rule says on the page what --fix does to it');

  const page = fs.readFileSync(PAGE_FILE, 'utf8');
  assert(page === buildPage(), 'rules page: docs/index.html is in sync (npm run generate-rules-page)');
  assert(RULES.every((id) => page.includes(`<article class="rule" id="${id}"`)),
    'rules page: every rule has an anchor to link to');
  assert(!/<script src|<link rel="stylesheet"|https?:\/\/(?!github\.com|abap2ui5)/.test(page),
    'rules page: self-contained - no external stylesheet, script or font');

  // the README finding tables are hand-written - the one of the five places a
  // new rule moves to (AGENTS.md) that nothing generated. Now gated too.
  const readme = fs.readFileSync(path.join(FIX, '..', '..', 'README.md'), 'utf8');
  const missing = RULES.filter((id) => !readme.includes(`\`${id}\``));
  assert(!missing.length,
    `README: every rule id appears in the finding tables (missing: ${missing.join(', ') || 'none'})`);
}

console.log(failed ? `\n${failed} assertion(s) failed` : '\nall assertions passed');
process.exit(failed ? 1 : 0);
