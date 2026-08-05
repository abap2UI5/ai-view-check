/*
 * findings — severity, wording and source position for a finding.
 *
 * Every gate produces findings in the same shape ({ type, control?, member?,
 * value?, offset? }). What a finding *means* — does it break the app, is it
 * a portability warning, is it merely a hint — was until now decided
 * separately by each consumer (the CLI failed the build on everything, the
 * VS Code extension carried its own error/warning table, the wording was
 * copy-pasted between them). That judgement belongs to the linter, so it
 * lives here and everything else reads it from one place.
 *
 * A finding's `type` is its **rule id** — the name printed at the end of
 * every reported line, keyed in `abap2ui5lint.jsonc`'s `rules` block and
 * usable in a source directive. `SEVERITY_BY_TYPE` below is therefore the
 * rule registry: a type missing from it is not a known rule.
 */

/** Ordered from the mildest to the most severe — comparisons use the index. */
export const SEVERITIES = ['hint', 'warning', 'error'];

export const severityRank = (s) => Math.max(0, SEVERITIES.indexOf(s));

/*
 * error   — the app breaks: a dump, a control that will not load, a value
 *           UI5 rejects, or a defect that silently destroys the view
 * warning — it works on the machine it was written for, but not necessarily
 *           on the target system (version floor, deprecation), or the data
 *           behind it is not what the author thinks it is
 * hint    — worth knowing, never wrong by itself
 */
const SEVERITY_BY_TYPE = {
  // --- runtime dumps in z2ui5_cl_ai_xml itself -----------------------------
  'excess-shut': 'error',
  'duplicate-property': 'error',
  'attribute-without-element': 'error',
  // --- the class does not even compile -------------------------------------
  'popover-display-val': 'error',
  // --- the view does not load / UI5 rejects it -----------------------------
  'unknown-control': 'error',
  'unknown-property': 'error',
  'unknown-aggregation': 'error',
  'invalid-property-value': 'error',
  'invalid-aggregation-child': 'error',
  'too-many-children': 'error',
  'duplicate-id': 'error',
  'undeclared-namespace': 'error',
  'invalid-expression-binding': 'error',
  'sapui5-only-control': 'error',
  // --- silent at runtime, but the view is not what was written -------------
  'binding-to-nonpublic': 'error',
  'binding-for-event': 'error',
  'event-for-property': 'error',
  'unconverted-abap-boolean': 'error',
  'duplicate-aggregation': 'error',
  'aggregation-in-aggregation': 'error',
  'view-never-displayed': 'error',
  'collection-bound-to-property': 'error',
  'relative-binding-without-context': 'error',
  'display-root-mismatch': 'error',
  'event-arg-out-of-range': 'error',
  'invalid-frontend-action': 'error',
  'frontend-action-unknown-id': 'error',
  'unescaped-brace-in-style': 'error',
  'collapsed-brace-in-style': 'error',
  'date-type-without-source': 'error',
  'uncurated-formatter': 'error',
  'missing-view-display-on-navigated': 'error',
  // --- portability and data ------------------------------------------------
  'control-too-new': 'warning',
  'member-too-new': 'warning',
  'event-parameter-too-new': 'warning',
  'enum-value-too-new': 'warning',
  'ui5-internal-access': 'warning',
  'commercial-ui5-host': 'warning',
  'control-deprecated': 'warning',
  'member-deprecated': 'warning',
  'unknown-binding-path': 'warning',
  'binding-to-local': 'warning',
  'missing-required-aggregation': 'warning',
  'obsolete-binder': 'warning',
  'binding-type-mismatch': 'warning',
  'event-arg-unresolved': 'warning',
  'hardcoded-binding-path': 'warning',
  'separate-lifecycle-ifs': 'warning',
  'duplicate-for-iterator': 'warning',
  // --- worth knowing -------------------------------------------------------
  // a hint, not a warning: a control can FIRE more than its metadata
  // declares (ColorPickerPopover forwards the picker's change parameters
  // verbatim, colorString included, and declares none of that) — so a
  // missing declaration is strong evidence of a typo, never proof
  'unknown-event-parameter': 'hint',
  'event-without-handler': 'hint',
  'unused-public-attribute': 'hint',
  'settable-property-via-action': 'hint',
  'missing-accessibility': 'hint',
};

/** Every rule id the linter can report, sorted — the registry the config
 *  file and the schema generator validate against. */
export const RULES = Object.freeze(Object.keys(SEVERITY_BY_TYPE).sort());

/** The severity a rule carries before any `rules` override. */
export const defaultSeverityOf = (type) => SEVERITY_BY_TYPE[type] || 'error';

/** The rule id render-gate failures are reported under. It is not a
 *  configurable rule (use `render: false` to switch the gate off) — it only
 *  labels the line, so a render error reads like every other finding. */
export const RENDER_RULE = 'render-error';

/* The conventional prefix -> library pairs an undeclared-namespace fix may
 * assume. Closed by convention: anything else could mean any library, and a
 * fix that has to guess is worse than the finding. Lives HERE (not in
 * index.mjs) so in-process consumers that replicate the pipeline — the VS
 * Code extension's gate — attach the same fixes the CLI does. */
export const KNOWN_NS = Object.freeze({
  core: 'sap.ui.core', mvc: 'sap.ui.core.mvc',
  l: 'sap.ui.layout', layout: 'sap.ui.layout', form: 'sap.ui.layout.form',
  f: 'sap.f', table: 'sap.ui.table', u: 'sap.ui.unified', unified: 'sap.ui.unified',
  uxap: 'sap.uxap', tnt: 'sap.tnt', html: 'http://www.w3.org/1999/xhtml', cc: 'z2ui5.cc',
});

/**
 * Attach the undeclared-namespace fix where the prefix is conventional: the
 * declaration is inserted as a sibling attribute call right before the root's
 * first xmlns write — a single-line insertion, nothing to guess. ABAP sources
 * only; raw XML rarely misses one and has its own insertion grammar.
 * Mutates the findings, returns them.
 */
export function attachNamespaceFixes(findings, source) {
  for (const f of findings) {
    if (f.type !== 'undeclared-namespace') continue;
    const lib = KNOWN_NS[f.member];
    if (!lib) continue;
    const anchor = String(source).match(/->a\(\s*(?=n\s*=\s*`xmlns`)/);
    if (!anchor) continue;
    const at = anchor.index + anchor[0].length;
    f.fixes = [{ start: at, end: at, text: `n = \`xmlns:${f.member}\` v = \`${lib}\` )->a( ` }];
  }
  return findings;
}

/** The parsed `rules` entry for the render gate's pseudo-rule. Render errors
 *  are strings, not findings, so applyRules never sees them — index.mjs
 *  applies this to a result's renderErrors instead: `false` and a matching
 *  `exclude` drop them (with a note), a severity decides what a render error
 *  counts as for the exit code. Directives cannot address them — a render
 *  error has no line in the ABAP source. */
export function renderRuleConfig(rules) {
  return ruleConfig(rules?.[RENDER_RULE]);
}

/** An unlisted type counts as an error: a new rule is loud until it is
 *  deliberately classified, never silently ignored. A severity already set
 *  on the finding wins — that is how a `rules` override survives. */
export function severityOf(finding) {
  return finding?.severity || defaultSeverityOf(finding?.type);
}

const short = (v, n = 80) => String(v ?? '').slice(0, n);

/** One line, plain English, no leading punctuation — the same sentence for
 *  the CLI, the JSON output and any editor integration. */
export function describe(f) {
  switch (f.type) {
    case 'view-never-displayed':
      return 'a view is built but never displayed — client->view_display( ) is missing';
    case 'popover-display-val':
      return 'client->popover_display( val = … ) does not compile — popover_display imports xml, not val (unlike popup_display)';
    case 'uncurated-formatter':
      return `${f.control} ${f.member}: 'Formatter.${f.value}' is not in the curated formatter module — UI5 resolves the name at binding time and an unknown one silently yields no value; compute it in ABAP and bind the finished field`;
    case 'hardcoded-binding-path':
      return `an absolute binding path is written as text (${short(f.value, 40)}) — derive it from client->_bind( var ) (bare path: _bind( val = var path = abap_true )) so it moves with a variable rename`;
    case 'missing-view-display-on-navigated':
      return 'this check_on_navigated( ) branch never re-displays the view — after returning from the called app the browser keeps showing THAT app\'s view; call client->view_display( ) (or view_model_update( )) in the branch';
    case 'separate-lifecycle-ifs':
      return `a second IF client->${f.member}( ) in the same method — lifecycle checks belong in one IF/ELSEIF chain; separate IF blocks can run more than one branch per roundtrip`;
    case 'duplicate-for-iterator':
      return `FOR iterator '${f.member}' is used twice in one method — a 7.02 downport materializes each as DATA ${f.member} TYPE i and fails with "variable already defined"; use distinct names (i, j, k)`;
    case 'unknown-event-parameter':
      return `${f.control} ${f.event}: the event has no parameter $parameters>/${f.member} (declared: ${(f.allowed || []).join(', ')}) — the value arrives empty`;
    case 'missing-required-aggregation':
      return `${f.control} has data but no ${f.member} — it renders empty`;
    case 'relative-binding-without-context':
      return `${f.control} ${f.member} binds {${f.value}} relatively, but the control has no binding context — the model resolves it against nothing and the control renders empty; bind the root field with client->_bind( )`;
    case 'collection-bound-to-property':
      return `${f.control} ${f.member} is a scalar property but {${f.value}} is a table/structure`;
    case 'date-type-without-source':
      return `${f.control} ${f.member} binds ${f.value} without formatOptions.source — the JSON model carries a string, the type wants a Date object, and every format() raises a FormatException`;
    case 'binding-type-mismatch':
      return `${f.control} ${f.member} expects ${f.memberType} but {${f.value}} is a character field — it arrives as a JSON string, which UI5 rejects in future mode`;
    case 'display-root-mismatch':
      return f.value === 'mvc:View'
        ? `client->${f.member}( ) loads its XML as a fragment, but the document root is a ${f.value} — a view has no open( )`
        : `client->${f.member}( ) loads its XML as a view, but the document root is a ${f.value} — XMLView.create needs a mvc:View`;
    case 'frontend-action-unknown-id':
      return `CONTROL_BY_ID addresses '${f.value}', which no view of this class declares (known: ${(f.allowed || []).join(', ')}) — the frontend finds no control and the wire does nothing`;
    case 'invalid-frontend-action':
      return f.member === 'view slot'
        ? 'the empty 2nd t_arg of CONTROL_BY_ID is the obsolete view slot — the runtime inserts it now, and the empty one shifts the method out of place'
        : `${f.control}: '${f.value}' is not an accepted ${f.member} (allowed: ${(f.allowed || []).join(', ')}) — the frontend rejects the wire silently`;
    case 'collapsed-brace-in-style':
      return `${f.count} escaped brace(s) inside a |…| template in a <style> block (…${short(f.value, 40)}…) — the template collapses \\{ to { before the view is built; use a backtick literal`;
    case 'settable-property-via-action':
      return `${f.value}( ) drives ${f.control} ${f.member}, which is a bindable property — bind it two-way instead, so the state lives in the model and survives a view rebuild`;
    case 'unused-public-attribute':
      return `PUBLIC attribute ${f.member} is never bound, read or written — it is serialized and shipped on every roundtrip for nothing`;
    case 'unescaped-brace-in-style':
      return `${f.count} unescaped brace(s) in a <style> block (…${short(f.value, 40)}…) — the XMLView parser reads them as bindings; write \\{ and \\}`;
    case 'event-arg-out-of-range':
      return `get_event_arg( ${f.member} ) in the handler of ${f.value}, which sends ${f.count} t_arg — the read comes back empty`;
    case 'member-deprecated':
      return `${f.control} ${f.member} is deprecated (${short(f.deprecated?.text || f.deprecated, 70)})`;
    case 'aggregation-in-aggregation':
      return f.parentAggregation
        ? `${f.member} is an aggregation nested directly inside the aggregation ${f.parentAggregation} of ${f.control} — a missing shut( )?`
        : `${f.member} is an aggregation sitting at the view root — an aggregation belongs inside a control`;
    case 'duplicate-aggregation':
      return `${f.control} opens ${f.member} twice — the second tag replaces the first`;
    case 'duplicate-property':
      return `${f.member} is set twice on the same control — z2ui5_cl_ai_xml asserts on that`;
    case 'attribute-without-element':
      return `a( n = \`${f.member}\` ) without an element to attach it to — z2ui5_cl_ai_xml asserts on that`;
    case 'unconverted-abap-boolean':
      return `${f.member}: the ABAP boolean ${f.value} reaches the view as 'X'/' ' — wrap it in z2ui5_cl_ai_xml=>as_bool( )`;
    case 'unknown-binding-path':
      return f.context
        ? `${f.control} ${f.member}="{${f.value}}" — the rows of {${f.context}} have no such field (silently empty)`
        : `${f.control} ${f.member}="{${f.value}}" — the model has no such path (silently empty)`;
    case 'binding-for-event':
      return `${f.control} ${f.member} is an event but carries a binding — use client->_event( )`;
    case 'event-for-property':
      return `${f.control} ${f.member} is a property but carries an event handler — use client->_bind( )`;
    case 'obsolete-binder':
      return `client->${f.member}( ) is obsolete — use client->_bind( )`;
    case 'binding-to-local':
      return `${f.member} is a local variable — its value is lost after the roundtrip, bind an instance attribute`;
    case 'binding-to-nonpublic':
      return `${f.member} is bound but not PUBLIC — only public attributes are serialized into the model, so the first roundtrip fails with BINDING_ERROR; move it to the PUBLIC SECTION`;
    case 'ui5-internal-access':
      return `${f.value} is a private UI5 internal — no API contract, it changes across UI5 patches without notice; restructure to a two-way binding or a public parameter`;
    case 'commercial-ui5-host':
      return `${f.value} is the commercial SAPUI5 host — use sdk.openui5.org, or the app breaks on an OpenUI5-only landscape`;
    case 'enum-value-too-new':
      return `${f.control} ${f.member}="${f.value}" is @since ${f.since} — the enum value is newer than the ${f.minUi5} floor`;
    case 'event-without-handler':
      return `event ${f.value} is raised but never handled — dead control, unless the roundtrip alone is intended`;
    case 'event-arg-unresolved':
      return `t_arg ${f.value} is a bare-brace literal — it is neither resolved nor quoted and arrives EMPTY at get_event_arg( ); use the $-prefixed form (\${...}) for a client-resolved value`;
    case 'duplicate-id':
      return `id="${f.value}" is used twice — duplicate ID error at runtime`;
    case 'undeclared-namespace':
      return `namespace prefix '${f.member}' is used but never declared (xmlns:${f.member})`;
    case 'invalid-expression-binding':
      return `${f.control} ${f.member}: unbalanced braces/parens in the expression binding`;
    case 'missing-accessibility':
      return `${f.control} has no ${f.member} — not usable with a screen reader`;
    case 'sapui5-only-control':
      return `control ${f.control} needs SAPUI5 — ${f.library} is not part of OpenUI5`;
    case 'unknown-control':
      return `control ${f.control} does not exist in UI5 — typo?`;
    case 'event-parameter-too-new':
      return `${f.control} ${f.event}: the event parameter $parameters>/${f.member} is @since ${f.since} — newer than the ${f.minUi5} floor`;
    case 'control-too-new':
      return `control ${f.control} is @since ${f.since} — newer than the ${f.minUi5} floor`;
    case 'control-deprecated':
      return `control ${f.control} is deprecated (${short(f.deprecated?.text || f.deprecated)})`;
    case 'unknown-property':
      return `${f.control} has no property/event/association ${f.member} — typo?`;
    case 'unknown-aggregation':
      return `${f.control} has no aggregation ${f.member} — typo?`;
    case 'invalid-property-value':
      return `${f.control} ${f.member}="${f.value}" is not a valid value (${
        f.allowed ? `allowed: ${f.allowed.join(', ')}` : `expected ${f.memberType}`})`;
    case 'invalid-aggregation-child':
      return `${f.control} is not allowed in ${f.parentControl} ${f.member} (expects ${f.expected})`;
    case 'too-many-children':
      return `${f.control} ${f.member} takes one child, ${f.count} given`;
    case 'excess-shut':
      return 'one shut( ) more than the tree is deep — asserts at runtime';
    default:
      return `${f.control} ${f.member} is @since ${f.since} — newer than the ${f.minUi5} floor`;
  }
}

/*
 * Source positions. The gates record a character offset into the file they
 * were given (the ABAP class or the XML document); turning that into a
 * 1-based line/column needs the source, which only the caller has.
 */
/** Offsets where each line starts — computed once per source, so locating
 *  many findings in one file does not rescan the file per finding. */
function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

const positionIn = (starts, length, offset) => {
  if (typeof offset !== 'number' || offset < 0 || offset > length) return null;
  // binary search: the last line start at or before the offset
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
};

export function positionAt(source, offset) {
  return positionIn(lineStarts(source), source.length, offset);
}

/**
 * Enrich findings in place with everything a consumer would otherwise
 * recompute: severity, message and — when the gate recorded an offset —
 * line/column in `source`.
 */
export function annotate(findings, source) {
  const starts = source == null ? null : lineStarts(source);
  for (const f of findings) {
    f.severity = severityOf(f);
    f.message = describe(f);
    const pos = starts ? positionIn(starts, source.length, f.offset) : null;
    if (pos) { f.line = pos.line; f.column = pos.column; }
  }
  return findings;
}

/*
 * Per-rule configuration — the `rules` block of abap2ui5lint.jsonc.
 *
 * Same shape as abaplint's rule config next door: a rule is switched off with
 * `false`, given another severity with a string, and both plus a file
 * `exclude` list with an object. A repo that considers, say, the
 * accessibility hints noise says so once in its config instead of teaching
 * every consumer of the library its own opinion table.
 *
 *   "rules": {
 *     "missing-accessibility": false,
 *     "member-deprecated": "hint",
 *     "event-without-handler": { "severity": "warning", "exclude": ["/test/"] }
 *   }
 */
function ruleConfig(value) {
  if (value === undefined || value === null || value === true) return null;
  if (value === false) return { off: true };
  if (typeof value === 'string') return { severity: value.toLowerCase() };
  const cfg = {};
  if (value.severity) cfg.severity = String(value.severity).toLowerCase();
  // abaplint's wording: "file regex filename patterns to exclude, case insensitive"
  if (Array.isArray(value.exclude)) cfg.exclude = value.exclude.map((p) => new RegExp(p, 'i'));
  return cfg;
}

/**
 * Drop the findings a `rules` entry switched off (or excluded for this file)
 * and apply its severity overrides. Returns the surviving findings — the
 * input array is not mutated, the findings themselves are.
 */
export function applyRules(findings, rules, file = '') {
  if (!rules || !Object.keys(rules).length) return findings;
  const kept = [];
  for (const f of findings) {
    const cfg = ruleConfig(rules[f.type]);
    if (cfg) {
      if (cfg.off) continue;
      if (cfg.exclude?.some((re) => re.test(file))) continue;
      if (cfg.severity) f.severity = cfg.severity;
    }
    kept.push(f);
  }
  return kept;
}

/*
 * Source directives — the local escape hatch.
 *
 * `--allow` and the `rules` block are repo-wide; the case that actually
 * comes up is one line that knows better than the gate. Spelled the way
 * ui5lint spells it, carried by whatever comment the file has:
 *
 *   " abap2ui5lint-disable-next-line unknown-binding-path -- filled in a LOOP
 *   <!-- abap2ui5lint-disable-next-line -->
 *   " abap2ui5lint-disable   ... " abap2ui5lint-enable
 *
 * No rule id after the directive means every rule. Everything after `--` is
 * a reason and ignored — which is also what terminates an XML comment, so
 * the `-->` never reads as a rule. One directive per line; `-enable` closes
 * every open `-disable` block. A finding the gate could not place (no line)
 * cannot be suppressed this way.
 */
const DIRECTIVE_RE = /abap2ui5lint-(disable-next-line|disable-line|disable|enable)\b([^\n]*)/;

/** The rule ids named after a directive; null means "all rules". */
function directiveRules(text) {
  const ids = String(text).split('--')[0].split(/[\s,]+/).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

/**
 * Scan a source for directives. Returns null when it holds none (the common
 * case, and the reason this never costs anything), otherwise
 * `{ suppresses(line, rule) }`.
 */
export function parseDirectives(source) {
  if (!source || !String(source).includes('abap2ui5lint-')) return null;
  const perLine = new Map(); // line -> Set of rule ids, or null for all
  const spans = [];          // { from, to, rules }
  const open = [];
  const add = (line, rules) => {
    if (!perLine.has(line)) perLine.set(line, rules);
    else if (rules === null || perLine.get(line) === null) perLine.set(line, null);
    else for (const r of rules) perLine.get(line).add(r);
  };
  const lines = String(source).split('\n');
  lines.forEach((text, i) => {
    const m = DIRECTIVE_RE.exec(text);
    if (!m) return;
    const line = i + 1;
    const rules = directiveRules(m[2]);
    if (m[1] === 'disable-next-line') add(line + 1, rules);
    else if (m[1] === 'disable-line') add(line, rules);
    else if (m[1] === 'disable') open.push({ from: line, rules });
    else while (open.length) spans.push({ ...open.pop(), to: line });
  });
  while (open.length) spans.push({ ...open.pop(), to: lines.length + 1 });
  const covers = (rules, rule) => rules === null || rules.has(rule);
  return {
    suppresses(line, rule) {
      if (perLine.has(line) && covers(perLine.get(line), rule)) return true;
      return spans.some((s) => line >= s.from && line <= s.to && covers(s.rules, rule));
    },
  };
}

/** Drop the findings a directive in `source` suppresses. */
export function applyDirectives(findings, source) {
  const directives = parseDirectives(source);
  if (!directives) return findings;
  return findings.filter((f) => !(f.line && directives.suppresses(f.line, f.type)));
}
