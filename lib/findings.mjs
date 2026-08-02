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
  'binding-for-event': 'error',
  'event-for-property': 'error',
  'unconverted-abap-boolean': 'error',
  'duplicate-aggregation': 'error',
  'aggregation-in-aggregation': 'error',
  'view-never-displayed': 'error',
  'collection-bound-to-property': 'error',
  // --- portability and data ------------------------------------------------
  'control-too-new': 'warning',
  'member-too-new': 'warning',
  'event-parameter-too-new': 'warning',
  'control-deprecated': 'warning',
  'member-deprecated': 'warning',
  'unknown-binding-path': 'warning',
  'binding-to-local': 'warning',
  'missing-required-aggregation': 'warning',
  'obsolete-binder': 'warning',
  // --- worth knowing -------------------------------------------------------
  'event-without-handler': 'hint',
  'missing-accessibility': 'hint',
};

/** An unlisted type counts as an error: a new rule is loud until it is
 *  deliberately classified, never silently ignored. */
export function severityOf(finding) {
  return SEVERITY_BY_TYPE[finding?.type] || 'error';
}

const short = (v, n = 80) => String(v ?? '').slice(0, n);

/** One line, plain English, no leading punctuation — the same sentence for
 *  the CLI, the JSON output and any editor integration. */
export function describe(f) {
  switch (f.type) {
    case 'view-never-displayed':
      return 'a view is built but never displayed — client->view_display( ) is missing';
    case 'missing-required-aggregation':
      return `${f.control} has data but no ${f.member} — it renders empty`;
    case 'collection-bound-to-property':
      return `${f.control} ${f.member} is a scalar property but {${f.value}} is a table/structure`;
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
    case 'event-without-handler':
      return `event ${f.value} is raised but never handled — dead control, unless the roundtrip alone is intended`;
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
export function positionAt(source, offset) {
  if (typeof offset !== 'number' || offset < 0 || offset > source.length) return null;
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source[i] === '\n') { line++; lineStart = i + 1; }
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * Enrich findings in place with everything a consumer would otherwise
 * recompute: severity, message and — when the gate recorded an offset —
 * line/column in `source`.
 */
export function annotate(findings, source) {
  for (const f of findings) {
    f.severity = severityOf(f);
    f.message = describe(f);
    const pos = source == null ? null : positionAt(source, f.offset);
    if (pos) { f.line = pos.line; f.column = pos.column; }
  }
  return findings;
}
