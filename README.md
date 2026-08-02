# abap2UI5-linter

**Validate abap2UI5 views without an SAP system** — a CLI, library, and
GitHub Action extracted from the CI gates of
[ai-demokit](https://github.com/abap2UI5/ai-demokit), where they guard 276
generated ports of the official UI5 demo kit samples.

Two gates:

1. **Property gate** — everything the view writes is resolved against a UI5
   metadata snapshot (970 controls with their full member lists and types,
   219 enums, generated from the OpenUI5 sources). It reports:

   | Finding | Example |
   | --- | --- |
   | `unknown-control` | `sap.m.Shell2` — no such control |
   | `unknown-property` | `Button typ="…"` — no such property/event/association |
   | `invalid-property-value` | `Button type="Emphasised"` — outside `sap.m.ButtonType`; also non-numeric `int`/`float` and non-boolean values |
   | `unknown-aggregation` | `Page contentt` — no such aggregation |
   | `too-many-children` | two controls in a 0..1 aggregation |
   | `invalid-aggregation-child` | a control the aggregation's type does not accept |
   | `control-too-new` / `member-too-new` | introduced after your target UI5 version (default **1.71**) |
   | `event-parameter-too-new` | a `${$parameters>/name}` read back in a `t_arg` that the event only gained later — resolved per event, not per name |
   | `control-deprecated` / `member-deprecated` | control or property already deprecated at your target version |
   | `duplicate-aggregation` | the same aggregation opened twice under one control — the second tag replaces the first |
   | `aggregation-in-aggregation` | an aggregation directly inside another one — invalid XML, and the signature of a missing `shut( )`: UI5 then goes looking for a control class by that name |
   | `excess-shut` | one `shut( )` more than the builder tree is deep — asserts at runtime |
   | `duplicate-property` | the same attribute written twice on one control — `z2ui5_cl_ai_xml` asserts on it |
   | `attribute-without-element` | `a( )` on the bare factory root — nothing to attach it to, asserts too |
   | `duplicate-id` | the same `id` twice — duplicate-ID error at runtime |
   | `undeclared-namespace` | `ns = 'form'` without an `xmlns:form` |
   | `invalid-expression-binding` | unbalanced braces/parens in `{= … }` |
   | `sapui5-only-control` | needs SAPUI5, absent from OpenUI5 (see below) |
   | `missing-required-aggregation` | a `Table` bound to rows but given no `columns` — renders empty |
   | `collection-bound-to-property` | a table/structure bound to a scalar property |
   | `missing-accessibility` | icon-only `Button` without `tooltip`, `Image` without `alt` |

   Bindings and expressions are never value-checked (their value is a
   runtime matter), custom namespaces stay out of scope, and a control
   whose inheritance chain leaves the snapshot is never reported as
   missing a member — no guessing.
   **abap2UI5-specific rules** — the defects that stay *silent* at runtime,
   which no UI5 tooling can see because they live in the relationship
   between the ABAP class and the view it builds:

   | Finding | Why it matters |
   | --- | --- |
   | `unknown-binding-path` | a hand-written `{/TYPO}` the derived model has no path for — the field just stays empty. Inside a bound aggregation a relative `{TYPO}` is resolved against the **row**, so a misspelled column field is caught too — but only where the row's shape is known from the class's `TYPES`, never guessed |
   | `binding-for-event` / `event-for-property` | `_bind( )` on an event (dead control) or `_event( )` on a property |
   | `obsolete-binder` | `client->_bind_edit( )` — superseded by `client->_bind( )` |
   | `unconverted-abap-boolean` | an ABAP boolean written straight into the view: it arrives as `'X'`/`' '`, and UI5 reads any non-empty string as true — so `visible = abap_false` makes the control **visible**. Wrap it in `z2ui5_cl_ai_xml=>as_bool( )` |
   | `binding-to-local` | a local variable bound: the instance is serialized across the roundtrip, the method stack is not, so the value is lost |
   | `view-never-displayed` | a view is built but never handed to the client — an empty page, no error |
   | `event-without-handler` | an event nothing reacts to — a dead control, *unless* the roundtrip alone is intended (so: a hint, never an error) |
   | `event-arg-unresolved` | a bare-brace `t_arg` literal (`` `{COL}` ``): the runtime sends it verbatim but only `$`-prefixed expressions are resolved by UI5, so `get_event_arg( )` receives an **empty** value with no error anywhere. Write `` `${COL}` `` (a template *starting* with a `{0}` placeholder is fine — that form is quoted) |

Every finding carries a **severity**, a ready-made **message** and — where
the gate could place it — the **line and column** in the file it came from:

```
FAIL  src/zcl_my_app.clas.abap  (1 doc(s))
         20:9   error    a( n = `title` ) without an element to attach it to — z2ui5_cl_ai_xml asserts on that
         31:18  error    text is set twice on the same control — z2ui5_cl_ai_xml asserts on that
         44:22  warning  sap.m.GenericTile systemInfo is @since 1.92.0 — newer than the 1.71 floor
         51:35  hint     event NO_HANDLER is raised but never handled — dead control, unless the roundtrip alone is intended
```

| Severity | Meaning |
| --- | --- |
| `error` | the app breaks: a dump, a control that will not load, a value UI5 rejects, or a defect that silently destroys the view |
| `warning` | it works where it was written, but not necessarily on the target system (version floor, deprecation) — or the data behind it is not what the author thinks it is |
| `hint` | worth knowing, never wrong by itself |

`--fail-on error|warning|hint|never` decides which of them break the build
(default `warning`; `--advisory` is `--fail-on never`). Everything is always
*reported* — the threshold only sets the exit code.

2. **Render gate** — the view is loaded with a real `XMLView.create` in
   headless Chromium against the OpenUI5 runtime served locally from the
   `@openui5/*` npm packages, with UI5 *future mode* active — so a typo'd
   property, an unknown control, a broken expression binding, or a strict
   property-type violation fails **before** the app ever reaches a system.

Input can be:

- **ABAP classes** building views with the generic `z2ui5_cl_ai_xml` builder —
  the view XML is statically reconstructed from the builder calls, and a
  **typed mock model** is derived from the class's `TYPES`/`DATA`/`model_init`
  seeds, so bindings resolve realistically during the render.
- **Raw `*.view.xml` / `*.fragment.xml`** files.

## CLI

```sh
npm ci
npx playwright install chromium   # once, for the render gate

node cli.mjs src                          # check everything under src/
node cli.mjs src --ui5 1.120              # check against UI5 1.120
node cli.mjs src --allow sap.m.GenericTile.systemInfo   # accepted deviation
node cli.mjs src --no-render              # property gate only (no browser)
node cli.mjs src --fail-on error          # only real breakage fails CI
node cli.mjs src --advisory               # report, never fail the build
node cli.mjs src --json                   # machine-readable output (for tools)
```

Exit code 1 on any finding at or above `--fail-on` (default: `warning`) and
on any render error — CI-ready.

### SAPUI5 or OpenUI5

`--distribution sapui5|openui5` (`--openui5` as a shorthand, setting
`abap2ui5.viewCheck.distribution` in the VS Code extension) says which
distribution the target system serves. SAPUI5 ships libraries OpenUI5 does
not — `sap.ui.comp` (Smart controls), `sap.suite.*`, `sap.ushell`, `sap.fe`,
`sap.viz`, … — so a SmartTable is perfectly fine on SAPUI5 and a guaranteed
runtime error on OpenUI5. With `openui5` those controls are reported as
`sapui5-only-control`; the default `sapui5` accepts them silently (they are
outside the snapshot either way, and are never mistaken for a typo).

### Which UI5 version is checked against

`--ui5 <version>` (alias `--min-ui5`, setting `abap2ui5.viewCheck.minUi5` in
the VS Code extension) is the version **your system runs**. It drives both
directions:

- a control or member introduced *after* it is a finding (it would not exist
  on your system),
- a deprecation is only reported once it is *in effect* at that version — a
  control deprecated as of 1.149 is silent for a 1.71 target.

The metadata itself comes from the snapshot in `data/properties.json`,
generated from the `@openui5/*` sources this repo pins (its version is
printed in the CLI summary and stored as `ui5Version`). Existence checks are
therefore made against that snapshot: a control **removed** in a later UI5
than your target cannot be distinguished from a typo, so keep the snapshot at
or above the versions you target.

## Configuration file — `abap2ui5lint.jsonc`

Pin the settings in the checked repo instead of repeating CLI flags — same
idea as `abaplint.jsonc`. Discovery is eslint-style: `--config <file>` wins,
otherwise the file is searched upward from the current directory and from
each given path. Precedence per option: explicit CLI flag > config file >
built-in default (`--no-config` ignores the file entirely).

```jsonc
{
  "paths": ["src"],          // used when the CLI got no positional paths
  "ui5": "1.71",             // UI5 floor for the property gate
  "distribution": "sapui5",  // or "openui5"
  "failOn": "warning",       // error | warning | hint | never
  "render": true,            // false = skip the render gate (--no-render)
  "allow": []                // e.g. ["sap.m.Avatar.displaySize"]
}
```

Unknown keys fail loudly (typo protection). The GitHub Action defers to the
repo's config for every input you leave unset.

## GitHub Action

```yaml
jobs:
  lint-views:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: abap2UI5/abap2UI5-linter@main
        with:
          paths: src
          min-ui5: '1.71'
          fail-on: warning
          flags: '--allow sap.m.GenericTile.systemInfo'
```

## Library

```js
import { checkFiles, checkAbapSource, checkXmlSource } from '@abap2ui5/linter';

const results = await checkFiles(['src/zcl_my_app.clas.abap']);
// -> [{ file, findings: [...], renderErrors, docs, model }]
//    finding: { type, control, member, severity, message, line, column, ... }
```

`checkFiles`/`checkAbapSource`/`checkXmlSource` annotate their findings
themselves. Anything driving the gates directly (`checkNodes`,
`checkAbapRules`) gets the same from the `findings` subpath, so severity and
wording are never reinvented per consumer:

```js
import { annotate, severityOf, describe } from '@abap2ui5/linter/findings';

annotate(findings, source); // adds severity, message, line, column in place
```

`--json` output carries the annotated findings plus a `totals` count per
severity.

Consumers: the [ai-mcp](https://github.com/abap2UI5/ai-mcp) server exposes
these gates as MCP tools for AI coding agents; the
[VS Code extension](https://github.com/abap2UI5-addons/vscode-extension) is the
natural place to surface findings as editor diagnostics.

## What it cannot do (by design)

- Event round-trips and visual/UX fidelity stay with a live run (see
  ai-mcp's `run_app`).
- A class that builds view parts in helper methods without the handle idiom is
  not statically reconstructable — the render gate is **skipped with a notice**
  (an incomplete reconstruction would validate the wrong view). The property
  gate still runs on what was reconstructed.
- Enum *values* newer than the floor are invisible at the member-name level;
  members without `@since` count as always-available (they predate version
  tracking).
- A model field the class fills **in code** (a `LOOP` in `model_init`) instead
  of in a literal seed has no static value. The render gate therefore only
  ever sees what a seed sets — inventing an empty string for such a field
  would have UI5's strict mode reject a perfectly good view (`state=""` is not
  a `ValueState`). The property gate asks a second, complete picture of the
  model instead: every declared field of every declared structure, so a
  binding path is judged against what a row *has*, not against what a seed
  happened to set.

## Data

`data/properties.json` is generated from the OpenUI5 control sources — per
control the parent, class-level `@since`/`@deprecated`, interfaces, the
default aggregation and every declared member with its type, plus the enum
tables. The `@openui5/*` packages this repo already depends on ship those
sources, so a plain regenerate needs no OpenUI5 clone:

```sh
npm run generate-metadata                              # from node_modules
OPENUI5_DIR=/path/to/openui5 npm run generate-metadata # from a checkout
```

## Credits

The reconstruction, mock-model derivation, render harness and property gate
were built and battle-tested in
[ai-demokit](https://github.com/abap2UI5/ai-demokit) (`scripts/render-smoke.mjs`,
`scripts/property-check.mjs`, `scripts/generate-properties.mjs`) against the
official UI5 demo kit corpus. This package is the corpus-independent
extraction.
