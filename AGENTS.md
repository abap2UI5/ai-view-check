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
npm test                          # test/run.mjs, home-grown asserts, ~113 assertions
npm run generate-schema           # after adding a rule - the test gates the drift
node cli.mjs <files> --no-render  # fast property-gate-only loop while iterating
# settings can be pinned in the checked repo's abap2ui5lint.jsonc (lib/config.mjs;
# CLI flag > config > default; unknown keys and unknown rule ids fail loudly)
```

`npm test` fails with an unhelpful Chromium error after a bare `npm ci` —
the playwright install is mandatory, not optional. CI
(`.github/workflows/ci.yml`) runs exactly these steps on Node 22.

## Scope — what the linter can and cannot see

- Input is **`z2ui5_cl_ai_xml` builder classes** (`collectFiles` picks ABAP
  files containing the literal `z2ui5_cl_ai_xml=>factory`) plus raw
  `*.view.xml` / `*.fragment.xml`. Classes built with the frozen
  `z2ui5_cl_xml_view` fluent builder are **silently skipped** — a design
  boundary, not a bug to fix in passing: the class is on its way out, and
  support for it was deliberately added and reverted once already. The way
  in for such a repo is to migrate it (as
  [cds-wrapper](https://github.com/abap2UI5-addons/cds-wrapper) did), not to
  teach the reconstructor a second builder.
- The knowledge bound is the committed metadata snapshot (see below): the
  gate cannot know about anything newer than its `ui5Version`.

## Rule taxonomy — where each finding type is emitted

A finding's `type` **is its rule id** — printed at the end of every reported
line, keyed in the config's `rules` block, nameable in a source directive and
offered by the JSON schema. The registry is `SEVERITY_BY_TYPE` in
`lib/findings.mjs` (exported as `RULES`); a type missing from it is not a
known rule and the config will refuse it. Emit sites (grep the id to find the
exact line):

| Emitting file | Finding types |
| --- | --- |
| `lib/properties.mjs` | `unknown-control`, `control-too-new`, `control-deprecated`, `sapui5-only-control` (with `--distribution openui5`), `unknown-property`, `member-too-new`, `member-deprecated`, `event-parameter-too-new`, `invalid-property-value`, `unknown-aggregation`, `aggregation-in-aggregation`, `too-many-children`, `invalid-aggregation-child`, `duplicate-aggregation`, `missing-required-aggregation`, `duplicate-id`, `undeclared-namespace`, `invalid-expression-binding`, `binding-for-event`, `event-for-property`, `unknown-binding-path`, `collection-bound-to-property`, `missing-accessibility` |
| `lib/abap-rules.mjs` | `obsolete-binder`, `binding-to-local`, `unconverted-abap-boolean`, `event-without-handler`, `event-arg-unresolved`, `view-never-displayed` |
| `lib/reconstruct.mjs` | `excess-shut`, `duplicate-property`, `attribute-without-element`, `open-levels` (note-only) — via `prep.structure`, consumed in `lib/index.mjs` |
| `lib/render.mjs` | render-gate failures (real `XMLView.create` errors) |
| `lib/config.mjs` | no findings — the `abap2ui5lint.jsonc`/`.json` loader (discovery, validation, precedence, the `rules` block). New config keys go through its KNOWN set + a run.mjs assertion |
| `lib/findings.mjs` | no findings — the **severity/wording/position layer** (`severityOf`, `SEVERITIES`, `RULES`, messages) plus the two things a repo can say back to it: `applyRules` (the config's `rules` block) and `applyDirectives` (`abap2ui5lint-disable-*` comments). Every consumer (CLI, VS Code extension, ai-demokit `view-gates`, ai-mcp) reads what a finding *means* from here; a new finding type needs its severity classified here or consumers fall back to a default |
| `lib/report.mjs` | no findings — the **output layer**: `summarize`, the `stylish`/`json`/`markdown` formatters and the GitHub workflow-command annotations. The CLI only parses flags and picks one |

**A new rule moves four places together** — forgetting one has happened:

1. the emit site in `lib/`,
2. its severity in `SEVERITY_BY_TYPE` (`lib/findings.mjs`) — that is also what
   registers it as a rule id,
3. a fixture in `test/fixtures/` + assertions in `test/run.mjs`,
4. a row in the README finding-type table.

Then `npm run generate-schema` and commit `data/abap2ui5lint.schema.json`
with it — `npm test` fails while that file is stale.

## Deliberate kinship with ui5lint and abaplint

The audience is the audience of [UI5/linter](https://github.com/UI5/linter)
and [abaplint](https://github.com/abaplint/abaplint), so the surface is
theirs on purpose and a change that drifts from it needs a reason:

| Ours | Modelled on |
| --- | --- |
| `path` heading, `line:col severity message rule-id`, `N problems (…)`, `Success! No findings detected.` | ui5lint's stylish formatter |
| `--format stylish\|json\|markdown`, `--quiet`, `--version`, `--fix`-shaped flag names | ui5lint |
| `abap2ui5lint-disable-next-line`/`-disable-line`/`-disable`/`-enable`, reason after `--` | ui5lint directives |
| `abap2ui5lint.jsonc`, `rules: { id: false \| severity \| { severity, exclude } }`, JSON schema for editor completion | abaplint's config and `BasicRuleConfig` |
| bin alias `abap2ui5lint`, exit codes 0/1/2 | both |
| workflow-command annotations on the PR diff | abaplint's `actions-abaplint` |

Known deliberate divergences: severities are `error/warning/hint` (not
abaplint's `Error/Warning/Info` — `hint` is already load-bearing across
consumers), rule ids are kebab-case like ui5lint's rather than abaplint's
snake_case, and there is no `--fix` yet.

Known test-coverage debt (assert these when touching the area):
`invalid-aggregation-child`, `sapui5-only-control` and `open-levels`
currently have no test assertion.

## Static-check roadmap — app knowledge that can still move into the gate

The mission is to encode as much app-building knowledge as possible as
static checks, so an agent learns a rule from a finding instead of a doc.
Candidates, distilled from the app guide and the ai-demokit gotchas, in
rough feasibility order (each new rule follows the three-places rule above
plus a severity classification in `lib/findings.mjs`):

1. **Popup/view root mismatch** — `popup_display`/`popover_display` handed a
   root `mvc:View`, or `view_display` handed a `core:FragmentDefinition`.
   `reconstruct` knows each doc's root; `abap-rules` sees the display calls —
   they need to be joined per doc.
2. **Strictly-typed property bound to a `TYPE string` field** — UI5 2.x
   rejects a JSON string on an int/float/boolean property
   (`"100" is of type string, expected float`). `abap-rules` already parses
   `DATA ... TYPE`; `properties.json` knows the property type — join them for
   two-way `_bind` targets.
3. **Unbound PUBLIC attribute** (hint) — every PUBLIC attribute is serialized
   into the draft and shipped to the browser per roundtrip; one that no view
   ever binds is dead transport weight. Needs the class's PUBLIC DATA set
   minus every `_bind`/`{FIELD}` reference.
4. **`get_event_arg( n )` beyond the declared `t_arg` arity** — the event
   declares its args statically; reading past them returns initial (or 500s
   in the transpiled runtime). Cross-check per event name.
5. **Frontend-action wire tokens** — the first `t_arg` of `control_global`
   must be a whitelisted global (`MESSAGE_TOAST`, …), `binding_call` methods
   must be `filter`/`sort`, `CONTROL_METHODS` args are positional and extras
   are silently dropped. Needs a small committed catalog generated from the
   core's `FrontendAction.js` (same pattern as `data/properties.json`).
6. **Collapsed-brace expression bindings** — a `\{`-escaped brace inside a
   `|…|` template around a relative row field collapses and the attribute
   silently stops being a binding; heuristics exist in ai-demokit's
   pattern-lint and could generalize.

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
  `lib/` layout and CLI flags as a public contract. The **`--json` shape is
  part of that contract** — it may grow keys (`problems` was added that way),
  never lose or rename them. The human `stylish` output is not: it is for
  people, and it changed shape once already.
- The VS Code extension additionally pins a **linter commit SHA** in its
  `package-lock.json` for the bundled property gate — a new finding type is
  invisible in the editor until that lock is bumped there.
- **`abap2ui5lint.jsonc` is honoured by the CLI and the Action, not yet by
  the VS Code extension** (it calls the library directly and reads its
  thresholds from VS Code settings). Until that is wired up, a repo that
  pins a UI5 floor here gets a different verdict in the editor than in CI —
  see the extension's AGENTS.md for the intended fix (`export config` is
  already available as `@abap2ui5/linter/config`).

## Relation to ai-demokit — this repo is canonical now

ai-demokit's ancestor scripts (`property-check.mjs`, `structure-lint.mjs`,
`render-smoke.mjs`) were **deleted** when its gates were consolidated onto
this linter: ai-demokit consumes `@abap2ui5/linter` as a git npm dependency
and keeps only the corpus policy in its `scripts/view-gates.mjs` (which
ports, POST_171 deviations, declared skips, advisories). Rules of thumb:

- **All generic view-checking logic lives here**; ai-demokit-specific gate
  policy (sidecar deviations, corpus conventions) stays in `view-gates.mjs`.
- A behaviour change here changes ai-demokit's CI verdicts on the next
  dependency bump — check the corpus impact (`npm run view-gates` there)
  for changes to severities, finding types or the reconstructor.
- ai-demokit's own `ui5/properties.json` (older shape) now feeds only its
  coverage docs, not the gates — never copy one snapshot over the other.
- When ai-demokit's dependency points at a feature branch of this repo
  (`github:abap2UI5/abap2UI5-linter#<branch>`), it must go back to plain
  `github:abap2UI5/abap2UI5-linter` once that branch is merged.

## Related repositories

| Repository | Relation |
| --- | --- |
| [ai-demokit](https://github.com/abap2UI5/ai-demokit) | Origin of the gate logic; now consumes this package via `scripts/view-gates.mjs` (git npm dependency) |
| [ai-mcp](https://github.com/abap2UI5/ai-mcp) | `validate_view` imports `lib/index.mjs` + `lib/render.mjs` **by path** — a file-layout refactor here breaks it even if `exports` stays intact |
| [vscode-extension](https://github.com/abap2UI5-addons/vscode-extension) | Consumes the SHA-pinned package (property gate) and the runtime `render-gate-bundle` download |
| [abap2UI5](https://github.com/abap2UI5/abap2UI5) | Defines `z2ui5_cl_ai_xml`, the builder whose chains `lib/reconstruct.mjs` re-executes |
