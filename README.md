# ai-view-check

**Validate abap2UI5 views without an SAP system** — a CLI, library, and
GitHub Action extracted from the CI gates of
[ai-demokit](https://github.com/abap2UI5/ai-demokit), where they guard 276
generated ports of the official UI5 demo kit samples.

Two gates:

1. **Property gate** — every control and every written property/aggregation/
   association/event in the view is resolved against a UI5 metadata snapshot
   (925 controls, member `@since` via the parent chain, control-level
   `@since`/`@deprecated`). A member newer than your UI5 floor (default
   **1.71**), a deprecated control, or a control that does not exist at all
   in a covered UI5 library (`sap.m.Shell2` — a typo) is a finding; custom
   namespaces stay out of scope.
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
node cli.mjs src --min-ui5 1.71           # explicit UI5 floor
node cli.mjs src --allow sap.m.GenericTile.systemInfo   # accepted deviation
node cli.mjs src --no-render              # property gate only (no browser)
node cli.mjs src --advisory               # report, never fail the build
node cli.mjs src --json                   # machine-readable output (for tools)
```

Exit code 1 on any finding (unless `--advisory`) — CI-ready.

## GitHub Action

```yaml
jobs:
  view-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: abap2UI5/ai-view-check@main
        with:
          paths: src
          min-ui5: '1.71'
          flags: '--allow sap.m.GenericTile.systemInfo'
```

## Library

```js
import { checkFiles, checkAbapSource, checkXmlSource } from '@abap2ui5/view-check';

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

`data/properties.json` is generated from the OpenUI5 sources (control-level
and member-level JSDoc) — regenerate against a checkout with:

```sh
OPENUI5_DIR=/path/to/openui5 npm run generate-properties
```

## Credits

The reconstruction, mock-model derivation, render harness and property gate
were built and battle-tested in
[ai-demokit](https://github.com/abap2UI5/ai-demokit) (`scripts/render-smoke.mjs`,
`scripts/property-check.mjs`, `scripts/generate-properties.mjs`) against the
official UI5 demo kit corpus. This package is the corpus-independent
extraction.
