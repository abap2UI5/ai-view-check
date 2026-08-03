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
  let usage = '';
  try { cp.execFileSync('node', [CLI, '--nope'], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { usage = e.stderr ?? ''; }
  assert(/unknown option '--nope'/.test(usage), 'report: an unknown flag is refused, not read as a path');
}

// ---------------------------------------------------------------- schema ----
{
  const { render, SCHEMA_FILE } = await import('../scripts/generate-schema.mjs');
  const committed = fs.readFileSync(SCHEMA_FILE, 'utf8');
  assert(committed === render(), 'schema: data/abap2ui5lint.schema.json is in sync (npm run generate-schema)');
  const schema = JSON.parse(committed);
  const { RULES } = await import('../lib/findings.mjs');
  assert(Object.keys(schema.properties.rules.properties).length === RULES.length && RULES.includes('duplicate-id'),
    'schema: every rule id is offered to the editor');
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
}

console.log(failed ? `\n${failed} assertion(s) failed` : '\nall assertions passed');
process.exit(failed ? 1 : 0);
