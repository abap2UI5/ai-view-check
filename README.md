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
   | `enum-value-too-new` | the property is old, the VALUE is not — `GenericTile frameType="OneByHalf"` is @since 1.83 on a 1.71 target; the snapshot keeps the per-value `@since` from the enum's JSDoc |
   | `event-parameter-too-new` | a `${$parameters>/name}` read back in a `t_arg` that the event only gained later — resolved per event, not per name |
   | `unknown-event-parameter` | a `${$parameters>/typo}` the event does not declare — the value usually arrives **empty**. Judged only against an event the control declares itself; a hint, because a control can fire more than its metadata declares |
   | `control-deprecated` / `member-deprecated` | control or property already deprecated at your target version |
   | `duplicate-aggregation` | the same aggregation opened twice under one control — the second tag replaces the first |
   | `aggregation-in-aggregation` | an aggregation directly inside another one — invalid XML, and the signature of a missing `shut( )`: UI5 then goes looking for a control class by that name |
   | `excess-shut` | one `shut( )` more than the builder tree is deep — asserts at runtime |
   | `duplicate-property` | the same attribute written twice on one control — `z2ui5_cl_ai_xml` asserts on it |
   | `attribute-without-element` | `a( )` on the bare factory root — nothing to attach it to, asserts too |
   | `duplicate-id` | the same `id` twice — duplicate-ID error at runtime |
   | `undeclared-namespace` | `ns = 'form'` without an `xmlns:form` |
   | `display-root-mismatch` | a `mvc:View` handed to `popup_display( )`, or a `core:FragmentDefinition` to `view_display( )` — the slot decides whether the client uses `XMLView.create` or `Fragment.load` |
   | `invalid-expression-binding` | unbalanced braces/parens in `{= … }` |
   | `sapui5-only-control` | needs SAPUI5, absent from OpenUI5 (see below) |
   | `missing-required-aggregation` | a `Table` bound to rows but given no `columns` — renders empty |
   | `collection-bound-to-property` | a table/structure bound to a scalar property |
   | `settable-property-via-action` | a `CONTROL_BY_ID` `set…( )` on a control that has a bindable property of that name — bind it two-way instead |
   | `relative-binding-without-context` | a relative `{FIELD}` on a control outside any bound aggregation — it resolves against nothing and the control renders empty |
   | `frontend-action-unknown-id` | a `CONTROL_BY_ID` wire whose literal id no view of the class declares — the frontend finds nothing and the wire silently does nothing |
   | `date-type-without-source` | a `sap.ui.model.type.Date`/`DateTime`/`Time` binding with no `formatOptions.source` — the JSON model can only carry a string, so the type throws on every format |
   | `binding-type-mismatch` | an ABAP character field bound to a numeric/boolean property — it arrives as `"100"` where UI5 declared a float, which future mode rejects |
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
   | `unknown-binding-path` | a hand-written `{/TYPO}` the derived model has no path for — the field just stays empty. Also judged inside complex binding infos (`path: '/TYPO'`) and expression bindings (`${/TYPO}`); a numeric segment steps into the bound table's row (`/T_ITEMS/9/TEXT`). Inside a bound aggregation a relative `{TYPO}` is resolved against the **row**, so a misspelled column field is caught too — but only where the row's shape is known from the class's `TYPES`, never guessed |
   | `binding-for-event` / `event-for-property` | `_bind( )` on an event (dead control) or `_event( )` on a property |
   | `obsolete-binder` | `client->_bind_edit( )` — superseded by `client->_bind( )` |
   | `unconverted-abap-boolean` | an ABAP boolean written straight into the view: it arrives as `'X'`/`' '`, and UI5 reads any non-empty string as true — so `visible = abap_false` makes the control **visible**. Wrap it in `z2ui5_cl_ai_xml=>as_bool( )` |
   | `binding-to-local` | a local variable bound: the instance is serialized across the roundtrip, the method stack is not, so the value is lost |
   | `binding-to-nonpublic` | a PROTECTED/PRIVATE attribute bound — only PUBLIC attributes are serialized into the model, so the first roundtrip fails with `BINDING_ERROR`; move it to the `PUBLIC SECTION` |
   | `ui5-internal-access` | `mProperties` & friends read from a wire or binding — private UI5 internals with no API contract, they change across UI5 patches without notice |
   | `commercial-ui5-host` | a URL pinned to `ui5.sap.com` / `*.hana.ondemand.com` — use `sdk.openui5.org`, or the app breaks on an OpenUI5-only landscape |
   | `view-never-displayed` | a view is built but never handed to the client — an empty page, no error |
   | `event-without-handler` | an event nothing reacts to — a dead control, *unless* the roundtrip alone is intended (so: a hint, never an error) |
   | `invalid-frontend-action` | a frontend-action `t_arg` outside the set the runtime accepts — an unknown `CONTROL_GLOBAL` object or method, a `BINDING_CALL` method that is not `filter`/`sort`, or `CONTROL_BY_ID`'s obsolete empty view slot. The browser logs and does nothing |
   | `unescaped-brace-in-style` | literal CSS braces in a `<style>` block — the XMLView parser reads them as bindings and the view dies; write `\{` and `\}` |
   | `collapsed-brace-in-style` | the same escape written inside a `\|…\|` template — the template collapses `\{` to `{` before the builder sees it, so the view dies anyway; use a backtick literal |
   | `unused-public-attribute` | a PUBLIC attribute nothing in the class ever touches — only PUBLIC attributes are serialized, so it is shipped to the browser every roundtrip for nothing |
   | `event-arg-out-of-range` | `get_event_arg( n )` past the `t_arg` the event declares — the read comes back empty (a 500 in the transpiled runtime). Judged only for a literal index, inside the handler of an event the class raises itself |
   | `event-arg-unresolved` | a bare-brace `t_arg` literal (`` `{COL}` ``): the runtime sends it verbatim but only `$`-prefixed expressions are resolved by UI5, so `get_event_arg( )` receives an **empty** value with no error anywhere. Write `` `${COL}` `` (a template *starting* with a `{0}` placeholder is fine — that form is quoted) |
   | `popover-display-val` | `popover_display( val = … )` does not compile — the parameter is `xml`, unlike `popup_display`'s `val`. Caught here because nothing in a systemless pipeline meets a compiler |
   | `uncurated-formatter` | a `formatter: 'Formatter.…'` naming a function the framework's curated module does not export — UI5 resolves the string at binding time and an unknown name silently yields **no value**; compute it in ABAP and bind the finished field |
   | `hardcoded-binding-path` | an absolute binding path written as text (`{/PATH}`, `path: '/PATH'`) — derive it from `client->_bind( var )` so it moves with a variable rename; an OData entity path in a class that switches its default model is exempt |
   | `missing-view-display-on-navigated` | a `check_on_navigated( )` branch that never re-displays — after returning from a called app the browser keeps showing *that* app's view |
   | `separate-lifecycle-ifs` | lifecycle checks in separate `IF` blocks instead of one `IF`/`ELSEIF` chain — separate blocks can run more than one branch per roundtrip (a guard block that `RETURN`s is exclusive and fine) |
   | `duplicate-for-iterator` | the same `FOR` iterator name twice in one method — a 7.02 downport materializes each as `DATA <name> TYPE i` and fails activation |

The name in the left column is the **rule id**: it is printed at the end of
every reported line, it is the key in the `rules` block of the config file,
and it is what a source directive names. Every rule is documented one page
away — **[abap2ui5.github.io/linter](https://abap2ui5.github.io/linter/)**,
searchable, one anchor per id. Every finding also carries a
**severity**, a ready-made **message** and — where the gate could place it —
the **line and column** in the file it came from:

```
src/zcl_my_app.clas.abap
  20:9   error    a( n = `title` ) without an element to attach it to …            attribute-without-element
  31:18  error    text is set twice on the same control …                          duplicate-property
  44:22  warning  sap.m.GenericTile systemInfo is @since 1.92.0 …                   member-too-new
  51:35  hint     event NO_HANDLER is raised but never handled …                    event-without-handler

4 problems (2 errors, 1 warning, 1 hint)
abap2ui5-linter: 12 file(s), 1 failing, 0 skipped (target SAPUI5 1.71, metadata from 1.150.0, failing on warning)
```

Files with nothing to report are not printed.

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
node cli.mjs src --fix                    # correct what is mechanical, report the rest
node cli.mjs src --quiet                  # errors only (the counts stay complete)
node cli.mjs src --format json            # machine-readable output (for tools)
node cli.mjs src --format markdown        # for a PR comment or a job summary
node cli.mjs --version                    # version and script location
```

Installed, the binary is `abap2ui5-linter` — or `abap2ui5lint`, the short
spelling that matches the config file name.

| Exit code | |
| --- | --- |
| `0` | clean, or nothing above `--fail-on` |
| `1` | a finding at or above `--fail-on` (default: `warning`), or a render error |
| `2` | bad usage or a broken config file |

`--format` takes `stylish` (the default shown above), `json`, `markdown` and
`sarif`; `--json` is a shorthand for `--format json`. The SARIF log is what
GitHub code scanning ingests — upload it with `github/codeql-action/upload-sarif`
and findings land in the Security tab and as native PR annotations. Inside
GitHub Actions every finding is additionally emitted as a workflow command
(alongside `stylish` only, so the machine formats stay parseable) —
`--no-annotate` turns that off, `--annotate` forces it on elsewhere.

## `--fix`

Five rules carry an exact correction and are rewritten in place; the run
then reports what is left, so `--fix` can go in front of any other flag
(`--fix-dry-run` reports what it would change without writing a file).

| Rule | What `--fix` writes |
| --- | --- |
| `obsolete-binder` | `client->_bind_edit( … )` → `client->_bind( … )`, arguments untouched |
| `unconverted-abap-boolean` | a bare token wrapped in `z2ui5_cl_ai_xml=>as_bool( … )` — an expression is left alone |
| `event-arg-unresolved` | the missing `$` inserted (`` `{COL}` `` → `` `${COL}` ``), a `\|…\|` template left alone |
| `popover-display-val` | `popover_display( val = … )` → `popover_display( xml = … )`, the argument untouched |
| `undeclared-namespace` | the missing `xmlns:` declaration inserted at the view root — for the conventional prefixes (`core`, `mvc`, `l`, `form`, `f`, `table`, `u`, `uxap`, `tnt`, `html`, `cc`) only; any other prefix could mean any library |

Nothing else is touched: a correction that has to guess (which of two
duplicate attributes survives, what event a `_bind` on an event slot meant to
raise) is worse than the finding it replaces. A rule waived by a directive or
by the config is never rewritten, and overlapping corrections are deferred to
the next run rather than merged. `ABAP2UI5LINT_FIX_DRY_RUN=true` reports what
it would change without writing a file.

## Waiving a rule

Three scopes, from narrow to wide:

**One line** — a comment in the source, spelled the way ui5lint spells it and
carried by whatever comment syntax the file has:

```abap
" abap2ui5lint-disable-next-line unknown-binding-path -- filled in a LOOP
)->a( n = `text` v = `{PRICE}`
```

```xml
<!-- abap2ui5lint-disable-next-line unknown-property -->
```

`-disable-line` waives the line the comment sits on, `-disable` … `-enable`
waives a block. Naming no rule waives every rule; everything after `--` is a
reason and is ignored — which is also what ends an XML comment, so the `-->`
is never read as a rule id.

**One repo** — the `rules` block of the config file (see below): switch a rule
off, give it another severity, or exclude files from it.

**One member** — `--allow sap.m.Avatar.displaySize` keeps using a control or
member that is newer than the floor, without touching the rule itself.

### Adopting the linter on an existing repo — the baseline

Switching a linter on over a grown codebase reports everything at once, and
the escapes above all lose information (`rules: false` drops the rule,
directives touch every line). The **baseline** freezes the debt instead:

```bash
npx abap2ui5-linter src --update-baseline     # writes abap2ui5lint-baseline.json
```

Commit that file and point the config at it (`"baseline":
"abap2ui5lint-baseline.json"`, or `--baseline <file>`). From then on the
frozen findings are suppressed (counted, never listed), **new** findings fail
normally — and an entry whose finding is gone is **stale and fails too**, so
the baseline only ever shrinks (rerun `--update-baseline` after fixing
things). Keys are line-free (`file|rule|control|member|value` with a count),
so moving code around does not invalidate them. Render errors are not
baselineable — `rules: { "render-error": { "exclude": […] } }` covers those.

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
idea as `abaplint.jsonc`, and `abap2ui5lint.json` is discovered too.
Discovery is eslint-style: `--config <file>` wins, otherwise the file is
searched upward from the current directory and from each given path.
Precedence per option: explicit CLI flag > config file > built-in default
(`--no-config` ignores the file entirely).

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/abap2UI5/linter/main/data/abap2ui5lint.schema.json",
  "paths": ["src"],          // used when the CLI got no positional paths
  "ui5": "1.71",             // UI5 floor for the property gate
  "distribution": "sapui5",  // or "openui5"
  "failOn": "warning",       // error | warning | hint | never
  "render": true,            // false = skip the render gate (--no-render)
  "allow": [],               // e.g. ["sap.m.Avatar.displaySize"]
  "baseline": "abap2ui5lint-baseline.json",  // adoption-time debt, see above
  "rules": {
    "missing-accessibility": false,        // off
    "member-deprecated": "hint",           // another severity
    "event-without-handler": {             // both, plus file exclusions
      "severity": "warning",
      "exclude": ["/test/"]                // file regex, case insensitive
    },
    // the render gate's pseudo-rule: waive render failures per file instead
    // of render:false wholesale. A waived file that renders CLEAN is called
    // out as a stale waiver, so the exclusion cannot quietly outlive its bug.
    "render-error": { "exclude": ["legacy/"] }
  }
}
```

The `$schema` line gives editors completion and validation for every key and
every rule id — `data/abap2ui5lint.schema.json` is generated from the rule
registry, so it can never drift from the linter (`npm run generate-schema`).

Unknown keys — and unknown rule ids — fail loudly (typo protection). The
GitHub Action defers to the repo's config for every input you leave unset.

## GitHub Action

```yaml
jobs:
  lint-views:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: abap2UI5/linter@main
        with:
          paths: src
          min-ui5: '1.71'
          fail-on: warning
          flags: '--allow sap.m.GenericTile.systemInfo'
```

Findings are annotated onto the pull request diff by default; set
`annotations: false` to keep the log plain.

## Library

```js
import { checkFiles, checkAbapSource, checkXmlSource } from '@abap2ui5/linter';

const results = await checkFiles(['src/zcl_my_app.clas.abap']);
// -> [{ file, findings: [...], renderErrors, docs, model }]
//    finding: { type, control, member, severity, message, line, column, ... }
```

`checkFiles`/`checkAbapSource`/`checkXmlSource` annotate their findings
themselves and honour `rules` plus the source directives — pass `rules` (and,
for `exclude`, the `file` the source came from) in the options. Anything
driving the gates directly (`checkNodes`, `checkAbapRules`) gets the same from
the `findings` subpath, so severity and wording are never reinvented per
consumer:

```js
import { annotate, applyRules, applyDirectives, RULES, severityOf, describe }
  from '@abap2ui5/linter/findings';

annotate(findings, source);                       // severity, message, line, column
findings = applyRules(findings, rules, file);     // the repo's rules block
findings = applyDirectives(findings, source);     // abap2ui5lint-disable-* comments
```

`RULES` is the full rule-id registry. The `report` subpath holds the
formatters (`formatStylish`, `formatJson`, `formatMarkdown`,
`githubAnnotations`, `summarize`) if you want the same output elsewhere.
`--json` output carries the annotated findings plus a `totals` count per
severity and a `problems` total.

Consumers: the [ai-mcp](https://github.com/abap2UI5/ai-mcp) server exposes
these gates as MCP tools for AI coding agents; the
[VS Code extension](https://github.com/abap2UI5/vscode-extension) is the
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

Two more artefacts are generated from the rule registry in `lib/findings.mjs`
and the prose in `lib/rule-docs.mjs` — `npm test` fails while either is stale:

```sh
npm run generate-schema      # data/abap2ui5lint.schema.json — editor completion
npm run generate-rules-page  # docs/index.html — the published rule reference
```

## Credits

The reconstruction, mock-model derivation, render harness and property gate
were built and battle-tested in
[ai-demokit](https://github.com/abap2UI5/ai-demokit) (`scripts/render-smoke.mjs`,
`scripts/property-check.mjs`, `scripts/generate-properties.mjs`) against the
official UI5 demo kit corpus. This package is the corpus-independent
extraction.
