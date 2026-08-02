/*
 * rule-docs — the prose behind every rule id.
 *
 * The reference the rules page (docs/index.html) and the README table are
 * generated from, so there is one place that says what a rule means. The
 * runtime does not import this: a finding's one-line message lives in
 * findings.mjs and has to stand on its own in a terminal. What is here is the
 * paragraph that does not fit there — why the defect matters, and what the
 * fix looks like.
 *
 * Every id in findings.mjs `RULES` needs an entry; npm test fails otherwise.
 *
 *   category  which group the rule appears under
 *   summary   one line, the README table cell
 *   detail    the paragraph on the rules page
 *   example   optional: the shortest source that triggers it
 */

export const CATEGORIES = [
  { id: 'metadata', title: 'Controls and members', blurb: 'Everything the view writes, resolved against the UI5 metadata snapshot generated from the OpenUI5 sources.' },
  { id: 'structure', title: 'View structure', blurb: 'Defects in the shape of the document itself — several of them make z2ui5_cl_ai_xml assert before a view is ever produced.' },
  { id: 'version', title: 'Version and deprecation', blurb: 'Portability against the UI5 version your system actually runs (--ui5, default 1.71) and the distribution it serves (--distribution).' },
  { id: 'abap2ui5', title: 'abap2UI5 semantics', blurb: 'The defects that stay silent at runtime, because they live in the relationship between the ABAP class and the view it builds. No UI5 tooling can see them.' },
  { id: 'data', title: 'Data and usability', blurb: 'The view loads and renders — but not with the data, or not for the user, the author had in mind.' },
];

export const RULE_DOCS = {
  /* ── controls and members ───────────────────────────────────────────── */
  'unknown-control': {
    category: 'metadata',
    summary: '`sap.m.Shell2` — no such control',
    detail: 'The control name is not in the metadata snapshot under any known library. Almost always a typo; UI5 fails to load the class and the view never appears. A control from a custom namespace is out of scope and never reported here.',
    example: 'view->leaf( `Buton` )',
  },
  'unknown-property': {
    category: 'metadata',
    summary: '`Button typ="…"` — no such property, event or association',
    detail: 'The attribute does not exist on the control or anywhere in its inheritance chain. UI5 in future mode rejects the view. A control whose chain leaves the snapshot is never reported as missing a member — the linter does not guess.',
    example: 'view->leaf( `Button` )->a( n = `typ` v = `Emphasized` )',
  },
  'unknown-aggregation': {
    category: 'metadata',
    summary: '`Page contentt` — no such aggregation',
    detail: 'An aggregation tag the parent control does not declare. UI5 then looks for a control class by that name and fails.',
  },
  'invalid-property-value': {
    category: 'metadata',
    summary: '`Button type="Emphasised"` — outside `sap.m.ButtonType`',
    detail: 'The literal is not a member of the enum the property is typed with, or it is not a number on an int/float property, or not a boolean on a boolean one. UI5 in future mode refuses the view rather than falling back to a default. Bindings and expressions are never value-checked — their value is a runtime matter.',
  },
  'invalid-aggregation-child': {
    category: 'metadata',
    summary: 'a control the aggregation\'s type does not accept',
    detail: 'The aggregation declares a type, and the control put inside it does not inherit from it. UI5 refuses to add the child, so the part of the view below it silently disappears.',
  },
  'too-many-children': {
    category: 'metadata',
    summary: 'two controls in a 0..1 aggregation',
    detail: 'A single-cardinality aggregation was filled more than once. Only one child survives — which one is not something to rely on.',
  },
  'missing-required-aggregation': {
    category: 'data',
    summary: 'a `Table` bound to rows but given no `columns` — renders empty',
    detail: 'The control has data but not the aggregation it needs to show any of it. Nothing fails: the table renders, and it renders empty, which is the hardest kind of bug to see in a screenshot.',
  },

  /* ── view structure ─────────────────────────────────────────────────── */
  'excess-shut': {
    category: 'structure',
    summary: 'one `shut( )` more than the builder tree is deep',
    detail: 'The builder ascends past the root. z2ui5_cl_ai_xml asserts on it, so the app dumps before it renders.',
  },
  'duplicate-property': {
    category: 'structure',
    summary: 'the same attribute written twice on one control',
    detail: 'z2ui5_cl_ai_xml asserts on a repeated attribute rather than letting the second value win silently.',
  },
  'attribute-without-element': {
    category: 'structure',
    summary: '`a( )` on the bare factory root — nothing to attach it to',
    detail: 'An attribute call before any element was opened. There is no element to carry it, and the builder asserts.',
  },
  'duplicate-aggregation': {
    category: 'structure',
    summary: 'the same aggregation opened twice under one control',
    detail: 'The second tag replaces the first, so everything built into the first one is gone from the rendered view — without a word from anywhere.',
  },
  'aggregation-in-aggregation': {
    category: 'structure',
    summary: 'an aggregation directly inside another one',
    detail: 'Invalid XML, and the signature of a missing `shut( )`: UI5 goes looking for a control class by that aggregation name and fails.',
  },
  'duplicate-id': {
    category: 'structure',
    summary: 'the same `id` twice',
    detail: 'A duplicate-ID error at runtime — UI5 IDs are unique per view.',
  },
  'undeclared-namespace': {
    category: 'structure',
    summary: '`ns = \'form\'` without an `xmlns:form`',
    detail: 'The prefix is used but never declared on the view root, so the parser cannot resolve the control at all.',
  },
  'invalid-expression-binding': {
    category: 'structure',
    summary: 'unbalanced braces or parens in `{= … }`',
    detail: 'The expression binding cannot be parsed. UI5 reports a parse error and the attribute stays unbound.',
  },

  /* ── version and deprecation ────────────────────────────────────────── */
  'control-too-new': {
    category: 'version',
    summary: 'control introduced after your target UI5 version',
    detail: 'The control does not exist on the system you are targeting (`--ui5`, default 1.71), so the view will not load there — however well it works on a newer one. Waive a deliberate case with `--allow sap.m.Control`.',
  },
  'member-too-new': {
    category: 'version',
    summary: 'property, event or aggregation introduced after your target version',
    detail: 'Same as `control-too-new`, one level down. Members without an `@since` count as always available — they predate version tracking. Waive with `--allow sap.m.Control.member`.',
  },
  'event-parameter-too-new': {
    category: 'version',
    summary: 'a `${$parameters>/name}` the event only gained later',
    detail: 'An event parameter read back in a `t_arg` that the event did not carry yet at your floor. Resolved per event, not per parameter name, so an identically named parameter on another event does not mask it.',
  },
  'control-deprecated': {
    category: 'version',
    summary: 'control already deprecated at your target version',
    detail: 'Reported only once the deprecation is in effect at the version you target — a control deprecated as of 1.149 stays silent for a 1.71 target.',
  },
  'member-deprecated': {
    category: 'version',
    summary: 'property or event already deprecated at your target version',
    detail: 'As `control-deprecated`, per member. The replacement is usually named in the deprecation text the finding quotes.',
  },
  'sapui5-only-control': {
    category: 'version',
    summary: 'needs SAPUI5, absent from OpenUI5',
    detail: 'Only with `--distribution openui5`. SAPUI5 ships libraries OpenUI5 does not — `sap.ui.comp` (Smart controls), `sap.suite.*`, `sap.ushell`, `sap.fe`, `sap.viz` — so a SmartTable is fine on SAPUI5 and a guaranteed runtime error on OpenUI5.',
  },

  /* ── abap2UI5 semantics ─────────────────────────────────────────────── */
  'unknown-binding-path': {
    category: 'abap2ui5',
    summary: 'a hand-written `{/TYPO}` the derived model has no path for',
    detail: 'The field just stays empty — no error, anywhere. Inside a bound aggregation a relative `{TYPO}` is resolved against the row, so a misspelled column field is caught too, but only where the row shape is known from the class\'s `TYPES`. Never guessed.',
  },
  'binding-for-event': {
    category: 'abap2ui5',
    summary: '`_bind( )` on an event — a dead control',
    detail: 'The slot is an event, so a data binding in it never becomes a handler. The control renders and does nothing. Use `client->_event( )`.',
  },
  'event-for-property': {
    category: 'abap2ui5',
    summary: '`_event( )` on a property',
    detail: 'The mirror image: an event handler written into a data slot. Use `client->_bind( )`.',
  },
  'obsolete-binder': {
    category: 'abap2ui5',
    summary: '`client->_bind_edit( )` — superseded by `client->_bind( )`',
    detail: '`_bind` is two-way as well. The one documented exception is a call passing `custom_mapper_back` or `custom_filter_back`, which `_bind` has no parameters for — such a call is not reported.',
    fixNote: 'Rewritten to `client->_bind( )`, the arguments untouched.',
  },
  'unconverted-abap-boolean': {
    category: 'abap2ui5',
    summary: 'an ABAP boolean written straight into the view',
    detail: 'It arrives as `\'X\'` or `\' \'`, and UI5 reads any non-empty string as true — so `visible = abap_false` makes the control **visible**. The classic silent inversion. Wrap it in `z2ui5_cl_ai_xml=>as_bool( )`.',
    fixNote: 'A bare token is wrapped in `z2ui5_cl_ai_xml=>as_bool( )`; an expression is left alone.',
  },
  'binding-to-local': {
    category: 'abap2ui5',
    summary: 'a local variable bound',
    detail: 'The instance is serialized across the roundtrip, the method stack is not — so the value is gone when the answer comes back. Bind an instance attribute.',
  },
  'view-never-displayed': {
    category: 'abap2ui5',
    summary: 'a view is built but never handed to the client',
    detail: 'An empty page and no error: the builder ran, the result was never passed to `client->view_display( )` (or a popup/nav call).',
  },
  'event-without-handler': {
    category: 'abap2ui5',
    summary: 'an event nothing reacts to',
    detail: 'Usually a dead control — but in abap2UI5 an event also forces a roundtrip, and that alone synchronises the model back into ABAP. So this is a hint, never an error, and it is skipped entirely when handler names are not literals.',
  },
  'event-arg-unresolved': {
    category: 'abap2ui5',
    summary: 'a bare-brace `t_arg` literal (`` `{COL}` ``)',
    detail: 'The runtime sends it verbatim, but only `$`-prefixed expressions are resolved by UI5 — so `get_event_arg( )` receives an **empty** value, with no error anywhere. Write `` `${COL}` ``. A template that starts with a `{0}` placeholder is fine: that form is quoted.',
    fixNote: 'The missing `$` is inserted in the literal form; a `|…|` template is left alone.',
  },

  /* ── data and usability ─────────────────────────────────────────────── */
  'collection-bound-to-property': {
    category: 'data',
    summary: 'a table or structure bound to a scalar property',
    detail: 'The property receives an object where it expects a value. Nothing throws; the control shows nothing useful.',
  },
  'missing-accessibility': {
    category: 'data',
    summary: 'icon-only `Button` without `tooltip`, `Image` without `alt`',
    detail: 'The control is unusable with a screen reader. Never wrong by itself, so it is a hint — switch it off per repo with `"missing-accessibility": false` if your corpus has made another decision.',
  },
};
