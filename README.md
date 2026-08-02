# abap2UI5-linter

**Validate abap2UI5 views without an SAP system** — a CLI, library, and
GitHub Action extracted from the CI gates of
[ai-demokit](https://github.com/abap2UI5/ai-demokit), where they guard 276
generated ports of the official UI5 demo kit samples.

Two gates:

1. **Property gate** — everything the view writes is resolved against a UI5
   metadata snapshot (985 controls with their full member lists and types,
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
   | `control-deprecated` | already deprecated at your target version |
   | `excess-shut` | one `shut( )` more than the builder tree is deep — asserts at runtime |

   Bindings and expressions are never value-checked (their value is a
   runtime matter), custom namespaces stay out of scope, and a control
   whose inheritance chain leaves the snapshot is never reported as
   missing a member — no guessing.
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
node cli.mjs src --advisory               # report, never fail the build
node cli.mjs src --json                   # machine-readable output (for tools)
```

Exit code 1 on any finding (unless `--advisory`) — CI-ready.

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
          flags: '--allow sap.m.GenericTile.systemInfo'
```

## Library

```js
import { checkFiles, checkAbapSource, checkXmlSource } from '@abap2ui5/linter';

const results = await checkFiles(['src/zcl_my_app.clas.abap']);
// -> [{ file, findings: [{type, control, member, since}], renderErrors, docs, model }]
```

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
