# AGENTS.md — abap2UI5-linter

Single source of truth for agents working on the **abap2UI5 view linter** —
the standalone property + render gates for abap2UI5 views (`z2ui5_cl_ai_xml`
builder classes and `*.view.xml`/`*.fragment.xml`), usable as CLI, library
and GitHub Action, no SAP system required.

> This entire project is in **English**. Plain ESM JavaScript, Node >= 22,
> no TypeScript, no build step, no formatter — do not add any of those.

## Build & verify

```bash
npm ci
npx playwright install chromium   # BEFORE npm test - the first test uses the render gate
npm test                          # test/run.mjs, home-grown asserts, ~35 assertions
node cli.mjs <files> --no-render  # fast property-gate-only loop while iterating
```

`npm test` fails with an unhelpful Chromium error after a bare `npm ci` —
the playwright install is mandatory, not optional. CI
(`.github/workflows/ci.yml`) runs exactly these steps on Node 22.

## Scope — what the linter can and cannot see

- Input is **`z2ui5_cl_ai_xml` builder classes** (`collectFiles` picks ABAP
  files containing the literal `z2ui5_cl_ai_xml=>factory`) plus raw
  `*.view.xml` / `*.fragment.xml`. Classes built with the classic
  `z2ui5_cl_xml_view` fluent builder are **silently skipped** — e.g. all of
  [cds-wrapper](https://github.com/abap2UI5-addons/cds-wrapper). That is a
  design boundary, not a bug to fix in passing.
- The knowledge bound is the committed metadata snapshot (see below): the
  gate cannot know about anything newer than its `ui5Version`.

## Rule taxonomy — where each finding type is emitted

There is **no rule registry**: finding types are string literals at their
emit sites. Current inventory (grep the id to find the exact line):

| Emitting file | Finding types |
| --- | --- |
| `lib/properties.mjs` | `unknown-control`, `control-too-new`, `control-deprecated`, `sapui5-only-control` (with `--distribution openui5`), `unknown-property`, `member-too-new`, `member-deprecated`, `invalid-property-value`, `unknown-aggregation`, `too-many-children`, `invalid-aggregation-child`, `duplicate-aggregation`, `missing-required-aggregation`, `duplicate-id`, `undeclared-namespace`, `invalid-expression-binding`, `binding-for-event`, `event-for-property`, `unknown-binding-path`, `collection-bound-to-property`, `missing-accessibility` |
| `lib/abap-rules.mjs` | `obsolete-binder`, `binding-to-local`, `unconverted-abap-boolean`, `event-without-handler`, `view-never-displayed` |
| `lib/reconstruct.mjs` | `excess-shut` (via `prep.structure`, consumed in `lib/index.mjs`) |
| `lib/render.mjs` | render-gate failures (real `XMLView.create` errors) |

**A new rule moves three places together** — forgetting one has happened:

1. the emit site in `lib/`,
2. a fixture in `test/fixtures/` + assertions in `test/run.mjs`,
3. a row in the README finding-type table.

Known test-coverage debt (assert these when touching the area):
`control-too-new`, `invalid-aggregation-child`, `event-for-property`,
`view-never-displayed`, and the positive case of
`invalid-expression-binding` currently have no test assertion.

## `data/properties.json` is generated — never hand-edit

The 434 KB one-line snapshot (`ui5Version` 1.150.0, 970 controls, 219
enums) is generated from the installed `@openui5/*` packages (or
`OPENUI5_DIR`) by:

```bash
npm run generate-metadata
```

Regenerate it **only** when bumping the `@openui5/*` pins in `package.json`,
and commit both together. There is **no CI drift gate** for it (unlike
ai-demokit's `meta_valid`) — a change to `generate-metadata.mjs` without a
regenerate merges silently, so regenerate + commit in the same change,
always. The snapshot's version bounds what the gate can know (reasoning in
the README).

## Release model — merging to main IS a release

- There is **no npm publish**; consumers install from git
  (`github:abap2UI5/abap2UI5-linter`). `package.json` stays at its version.
- `.github/workflows/bundle.yml` maintains the rolling prerelease tag
  **`render-gate-bundle`** with `view-check-bundle.tgz` (cli + lib + data +
  prod node_modules). **Installed VS Code extensions download this bundle at
  runtime** (`vscode-extension/src/rendergate.ts`) — merging a change to
  `cli.mjs`, `lib/`, `data/` or `package.json` silently updates what every
  installed extension fetches next. There is no version negotiation; treat
  `lib/` layout and CLI flags as a public contract.
- The VS Code extension additionally pins a **linter commit SHA** in its
  `package-lock.json` for the bundled property gate — a new finding type is
  invisible in the editor until that lock is bumped there.

## Relation to ai-demokit — who is canonical

This repo is the **corpus-independent extraction** of ai-demokit's
`property-check.mjs` / `render-smoke.mjs` / `generate-properties.mjs`.
The ancestors still live in ai-demokit (with their own, older
`ui5/properties.json` — 925 controls, different shape) because its gates
run against the port corpus with corpus-specific conventions. Rules of
thumb:

- **New generic view-checking logic belongs here**; ai-demokit-specific
  gate logic (sidecar deviations, corpus conventions) stays there.
- A bug found in shared logic is probably in **both** — check the ancestor
  when fixing, and vice versa.
- The two `properties.json` snapshots are **independent artifacts with
  different shapes** — never copy one over the other.

## Related repositories

| Repository | Relation |
| --- | --- |
| [ai-demokit](https://github.com/abap2UI5/ai-demokit) | Origin of the gate logic; still runs its own corpus-specific ancestors |
| [ai-mcp](https://github.com/abap2UI5/ai-mcp) | `validate_view` imports `lib/index.mjs` + `lib/render.mjs` **by path** — a file-layout refactor here breaks it even if `exports` stays intact |
| [vscode-extension](https://github.com/abap2UI5-addons/vscode-extension) | Consumes the SHA-pinned package (property gate) and the runtime `render-gate-bundle` download |
| [abap2UI5](https://github.com/abap2UI5/abap2UI5) | Defines `z2ui5_cl_ai_xml`, the builder whose chains `lib/reconstruct.mjs` re-executes |
