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
npm test                          # test/run.mjs, home-grown asserts, ~156 assertions
npm run generate-schema           # after adding a rule - the test gates the drift
npm run generate-rules-page       # ditto: docs/index.html, the published reference
node cli.mjs <files> --no-render  # fast property-gate-only loop while iterating
# settings can be pinned in the checked repo's abap2ui5lint.jsonc (lib/config.mjs;
# CLI flag > config > default; unknown keys and unknown rule ids fail loudly)
```

`npm test` fails with an unhelpful Chromium error after a bare `npm ci` —
the playwright install is mandatory, not optional. CI
(`.github/workflows/ci.yml`) runs exactly these steps on Node 22.

Changing a **severity, a finding type or the reconstructor** additionally
needs the consumers checked — `.github/workflows/downstream.yml` does that on
every PR, and the same thing runs locally against sibling checkouts:

```bash
.github/scripts/substitute-linter.sh . ../ai-demokit
(cd ../ai-demokit && node scripts/view-gates.mjs --strict --no-render)
```

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
- **One builder chain per document.** The reconstructor reads a chain as one
  ABAP statement; a chain **split across statements on the same handle**
  (`popover->open( … ).` then `popover->open( \`List\` )`) keeps its cursor at
  runtime but is re-rooted here, so the document comes out with two roots.
  It fails loudly (the render gate rejects it as native HTML content) rather
  than silently — but the fix is in the port: write one chain per view.

## Rule taxonomy — where each finding type is emitted

A finding's `type` **is its rule id** — printed at the end of every reported
line, keyed in the config's `rules` block, nameable in a source directive and
offered by the JSON schema. The registry is `SEVERITY_BY_TYPE` in
`lib/findings.mjs` (exported as `RULES`); a type missing from it is not a
known rule and the config will refuse it. Emit sites (grep the id to find the
exact line):

| Emitting file | Finding types |
| --- | --- |
| `lib/properties.mjs` | `unknown-control`, `control-too-new`, `control-deprecated`, `sapui5-only-control` (with `--distribution openui5`), `unknown-property`, `member-too-new`, `member-deprecated`, `event-parameter-too-new`, `invalid-property-value`, `unknown-aggregation`, `aggregation-in-aggregation`, `too-many-children`, `invalid-aggregation-child`, `duplicate-aggregation`, `missing-required-aggregation`, `duplicate-id`, `undeclared-namespace`, `invalid-expression-binding`, `binding-for-event`, `event-for-property`, `unknown-binding-path`, `collection-bound-to-property`, `binding-type-mismatch`, `missing-accessibility` |
| `lib/abap-rules.mjs` | `obsolete-binder`, `binding-to-local`, `unconverted-abap-boolean`, `event-without-handler`, `event-arg-unresolved`, `event-arg-out-of-range`, `invalid-frontend-action`, `unescaped-brace-in-style`, `collapsed-brace-in-style`, `unused-public-attribute`, `view-never-displayed` |
| `lib/reconstruct.mjs` | `excess-shut`, `duplicate-property`, `attribute-without-element`, `display-root-mismatch`, `open-levels` (note-only) — via `prep.structure`, consumed in `lib/index.mjs` |
| `lib/render.mjs` | render-gate failures (real `XMLView.create` errors) |
| `lib/config.mjs` | no findings — the `abap2ui5lint.jsonc`/`.json` loader (discovery, validation, precedence, the `rules` block). New config keys go through its KNOWN set + a run.mjs assertion |
| `lib/findings.mjs` | no findings — the **severity/wording/position layer** (`severityOf`, `SEVERITIES`, `RULES`, messages) plus the two things a repo can say back to it: `applyRules` (the config's `rules` block) and `applyDirectives` (`abap2ui5lint-disable-*` comments). Every consumer (CLI, VS Code extension, ai-demokit `view-gates`, ai-mcp) reads what a finding *means* from here; a new finding type needs its severity classified here or consumers fall back to a default |
| `lib/report.mjs` | no findings — the **output layer**: `summarize`, the `stylish`/`json`/`markdown` formatters and the GitHub workflow-command annotations. The CLI only parses flags and picks one |

**A new rule moves five places together** — forgetting one has happened:

1. the emit site in `lib/`,
2. its severity in `SEVERITY_BY_TYPE` (`lib/findings.mjs`) — that is also what
   registers it as a rule id,
3. an entry in `RULE_DOCS` (`lib/rule-docs.mjs`) — category, summary, detail,
4. a fixture in `test/fixtures/` + assertions in `test/run.mjs`,
5. a row in the README finding-type table.

Then regenerate and commit both artefacts — `npm test` fails while either is
stale:

```bash
npm run generate-schema      # data/abap2ui5lint.schema.json
npm run generate-rules-page  # docs/index.html
```

`lib/frontend-actions.mjs` is the one **hand-maintained** knowledge file:
the closed whitelists `invalid-frontend-action` judges against. Its source of
truth is abap2UI5's `z2ui5_cl_app_frontendaction_js` — a JavaScript module
embedded in an ABAP string concatenation, which is not worth parsing, and
that repo is not a dependency here. Refresh it by reading `GLOBAL_TARGETS`
and `BINDING_METHODS` there. Kept in step 2026-08-02 with abap2UI5's new
`POPUP: setWithinArea` target (`sap.ui.core.Popup.setWithinArea`, @since
1.89) — a target added upstream is a **silent** breaking change here until
this file follows: the linter reports the correct new wire as an
`invalid-frontend-action`. Only **closed** sets belong in it: `CONTROL_BY_ID`
accepts any control method that does not match a deny prefix, so a whitelist
for it would report correct code.

A rule may also carry `fixes: [{ start, end, text }]` (see `lib/fix.mjs`):
exact spans in the source it was given, applied by `--fix`. Attach them only
when the correction is mechanical — a fix that has to guess is worse than a
finding that stays — and describe it in the rule's `fixNote`, which the test
requires for everything listed in `FIXABLE`.

## Deliberate kinship with ui5lint and abaplint

The audience is the audience of [UI5/linter](https://github.com/UI5/linter)
and [abaplint](https://github.com/abaplint/abaplint), so the surface is
theirs on purpose and a change that drifts from it needs a reason:

| Ours | Modelled on |
| --- | --- |
| `path` heading, `line:col severity message rule-id`, `N problems (…)`, `Success! No findings detected.` | ui5lint's stylish formatter |
| `--format stylish\|json\|markdown`, `--quiet`, `--version` | ui5lint |
| `--fix` plus a `*_FIX_DRY_RUN` env escape | ui5lint's `--fix` / `UI5LINT_FIX_DRY_RUN` |
| `abap2ui5lint-disable-next-line`/`-disable-line`/`-disable`/`-enable`, reason after `--` | ui5lint directives |
| `abap2ui5lint.jsonc`, `rules: { id: false \| severity \| { severity, exclude } }`, JSON schema for editor completion | abaplint's config and `BasicRuleConfig` |
| `docs/index.html` — one searchable page, one anchor per rule id | rules.abaplint.org |
| bin alias `abap2ui5lint`, exit codes 0/1/2 | both |
| workflow-command annotations on the PR diff | abaplint's `actions-abaplint` |

Known deliberate divergences: severities are `error/warning/hint` (not
abaplint's `Error/Warning/Info` — `hint` is already load-bearing across
consumers), and rule ids are kebab-case like ui5lint's rather than abaplint's
snake_case.

Known test-coverage debt (assert these when touching the area):
`invalid-aggregation-child`, `sapui5-only-control` and `open-levels`
currently have no test assertion.

## Static-check roadmap — app knowledge that can still move into the gate

The mission is to encode as much app-building knowledge as possible as
static checks, so an agent learns a rule from a finding instead of a doc.
**The list distilled from the app guide and the ai-demokit gotchas is now
worked off**; every entry shipped:

| Roadmap entry | Rule |
| --- | --- |
| Popup/view root mismatch | `display-root-mismatch` |
| Strictly-typed property bound to a character field | `binding-type-mismatch` |
| `get_event_arg( n )` beyond the declared arity | `event-arg-out-of-range` |
| Frontend-action wire tokens | `invalid-frontend-action` (+ `lib/frontend-actions.mjs`) |
| Collapsed-brace expression bindings | `collapsed-brace-in-style`, alongside `unescaped-brace-in-style` |
| Unbound PUBLIC attribute | `unused-public-attribute` |
| Date/time model type without a `source` format | `date-type-without-source` |
| `CONTROL_BY_ID` naming an id no view declares | `frontend-action-unknown-id` |
| Relative binding on a control with no binding context | `relative-binding-without-context` |
| `CONTROL_BY_ID` `set…( )` on a bindable property | `settable-property-via-action` |

The last one shipped **narrower than it was written**: "no view binds it" is
not the same as dead. A PUBLIC attribute used only in ABAP code is state, not
ballast — PUBLIC is precisely how a value survives the roundtrip — so only a
name that appears once in the whole class, its own declaration, is reported.
Keep that distinction if the rule is ever widened.

The `date-type-without-source` entry came from the ai-demokit port of
`sap.ui.core.sample.TypeDateAsDate` (app 282): its JSON model holds a JS
`Date`, which an ABAP-fed model can never carry, so the port has to add
`formatOptions.source` to every binding. Neither the property gate (the
member exists) nor the render gate (it mocks the model) can see the
omission — a static read of the binding-info string can.

`frontend-action-unknown-id` came from the same batch (app 284, a
`navigateBack` on a MessageView that lives in the popup slot): the id is
the only part of a `CONTROL_BY_ID` wire nothing validated, and a wrong one
is silent in exactly the way the whole rule family exists for. It is
deliberately narrow — the id set is trusted only when EVERY `id`
attribute of the class is a literal, so a class that builds ids at
runtime is not judged at all.

`relative-binding-without-context` closes the **flattened-element-binding**
trap the ai-demokit porting guide could until now only describe as a manual
audit ("a `_bind`-less `` v = `{FIELD}` `` whose FIELD is a root-level DATA
scalar") — seven of its ports had shipped the wrong form. It needed a third
view of the class: the model and the shape only carry BOUND variables, so
`prepareAbap` now also returns `rootFields`, every attribute the class
declares. And it is the textbook case for the corpus rule below — the first
version reported four bindings in `sap.ui.table` **column templates**, which
are cloned per row and get their context from the table's `rows` binding in a
sibling aggregation. The corpus was right; the rule now treats any
`template` aggregation as a row context.

`settable-property-via-action` needed a THIRD input the ABAP-side rules did
not have: what the id in a wire actually is. `collectControlIds` +
`memberSection` / `propertyDecl` are exported from `properties.mjs` for it,
and `checkAbapRules` now takes `{ data, controlIds }` — with neither, the
rule simply stays silent. Its whole precision lives in the metadata: an
**association** (`selectedSection`) and a **function-typed** property
(`MessagePopover.asyncURLHandler`) can never be bound, so both are excluded
rather than reported and excused. It found five real ports on the corpus,
all five converted to bindings.

New candidates go here as they are found. Two rules of the trade the last
rounds established, before anything is added:

**A corpus run also measures the RECONSTRUCTOR, not only the rule.** The
`relative-binding-without-context` round found two model defects that had
been invisible because they cancel each other out: a `DATA t_x TYPE
ty_t_x.` (a **named** table type, not the inline `STANDARD TABLE OF`
form) was modelled as a **scalar**, so the render gate silently rendered
an empty aggregation and never instantiated the template — and fixing
that surfaced the second one, an **unseeded** table being given an
invented all-empty row, which the render gate then rejects on the first
enum or date property (`"" is of type string, expected sap.m.AvatarShape`).
Now: unseeded tables are empty for the renderer and a declared row in the
shape, the same split the scalars already had.

**Measure a new rule against the ai-demokit corpus before shipping it.**
`node cli.mjs /path/to/ai-demokit/src --no-render --json` over 282 real
ports, diffed per finding type against `main`, is what caught three separate
false-positive shapes: an event raised by a `message_box_display( onclose = )`
callback rather than `client->_event( )`, dispatch leaking across an
`ENDMETHOD`, and a `<style>` check scoped to the ABAP *statement* — which on
a builder chain is the entire view. A rule that lights up the corpus is
usually wrong before the corpus is.

**And check the rule can see anything at all.** Zero findings on the corpus
proves nothing on its own: `unused-public-attribute` was verified by
injecting a dead attribute into a real port (caught) and by counting what it
judges in silence (120 PUBLIC declarations across 37 of 60 sampled ports, all
correctly referenced). A rule that parses nothing is also a rule that reports
nothing.

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

**The generator is published with the package** (`files[]`) and takes
`--out <file>`, because it is the ecosystem's ONLY UI5 metadata parser.
ai-demokit used to carry a second one; the two drifted, and the other one was
wrong — it attributed a file-level `@deprecated` JSDoc block sitting on a local
variable to the CONTROL, marking `sap.f.DynamicPageTitle` and
`sap.f.semantic.SemanticPage` deprecated when neither class doc says so. Its
`generate_result` workflow now runs this generator instead:

```bash
OPENUI5_DIR=./openui5 node node_modules/@abap2ui5/linter/scripts/generate-metadata.mjs \
  --out ui5/properties.json
```

Note what that does **not** mean: ai-demokit does not reuse `data/properties.json`
itself. It builds its sample universe from an OpenUI5 *checkout* that can be
newer than the `@openui5` packages pinned here (1.152 vs 1.150 at the time of
writing, and npm has no 1.152), and a snapshot older than the universe loses
the `@since` of controls introduced in between — `scopeOf` then reads them as
in scope (`sap.f.HeroBanner` @1.152 is the live example). So: **one generator,
two invocations**, each at the version its own consumer needs. Keep the
generator's output shape additive for the same reason the `--json` shape is
frozen — ai-demokit's coverage docs read `controls[…].since` / `.deprecated`.

## Release model — merging to main IS a release

- There is **no npm publish**; consumers install from git
  (`github:abap2UI5/linter`). `package.json` stays at its version.
- **`docs/index.html` is published on merge** to
  https://abap2ui5.github.io/linter/ by `.github/workflows/pages.yml` — a
  reworded rule detail is live the moment it lands on main. The workflow only
  serves the committed file, it never regenerates it: a generator running in
  CI would paper over a stale commit instead of failing on it. Pages has to be
  enabled once in the repository settings, source "GitHub Actions".
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
  dependency bump. **`.github/workflows/downstream.yml` runs that check for
  you** on every push and PR — see below; you no longer have to remember to
  run the corpus by hand.
- Both consumers pin this repo by **commit SHA**
  (`github:abap2UI5/linter#<sha>`), so a merge here never moves them on its
  own; bumping the pin is a deliberate change in the consumer, and the
  downstream workflow is what says whether that bump is safe. A pin pointing
  at a **feature branch** of this repo is only ever temporary — it must become
  a SHA on main before that consumer's change is merged.

## The downstream contract — `.github/workflows/downstream.yml`

`npm test` only ever proves this linter against its own fixtures. The
downstream workflow proves it against the repos that actually consume it,
with **this checkout substituted for the SHA they pin**
(`.github/scripts/substitute-linter.sh` copies the published `files[]` over
`node_modules/@abap2ui5/linter`; the linter's own runtime deps stay hoisted in
the consumer, so no second install is needed):

| Job | What it catches |
| --- | --- |
| `ai-demokit corpus (280 ports)` | a rule that starts firing on real ports — run through `view-gates.mjs`, so corpus policy (POST_171 deviations, declared skips, advisories) applies and only a genuine regression fails |
| `vscode-extension typecheck` | a renamed or reshaped export — the extension imports the subpath exports against hand-written typings in its `src/linter.d.ts`, which nothing here would otherwise exercise |

A red downstream job is **not automatically a defect in the change**: a new
rule that fires on the corpus may well be right. It means the rollout has to
be decided — severity, an advisory period, or a corpus fix — rather than
landing unseen. Two traps worth knowing before reading a result:

- **Severity is not the whole story.** `view-gates.mjs` neutralises some rules
  by *type* (`ADVISORY_TYPES`), so raising one of those from `hint` to `error`
  changes nothing downstream. Conversely a **renamed rule id** is a silent
  breaking change: the consumer matches `VERSION_TYPES` and its sidecar
  deviations by type name, so a rename un-excuses every finding that name
  covered (renaming `member-too-new` fails 68 ports).
- The corpus exercises only a fraction of the rule set — as of this writing
  just six finding types fire across all 280 ports. A green corpus job means
  *no regression*, not *the new rule is covered*.

## Related repositories

| Repository | Relation |
| --- | --- |
| [ai-demokit](https://github.com/abap2UI5/ai-demokit) | Origin of the gate logic; now consumes this package via `scripts/view-gates.mjs` (git npm dependency) |
| [ai-mcp](https://github.com/abap2UI5/ai-mcp) | `validate_view` imports `lib/index.mjs` + `lib/render.mjs` **by path** — a file-layout refactor here breaks it even if `exports` stays intact |
| [vscode-extension](https://github.com/abap2UI5/vscode-extension) | Consumes the SHA-pinned package (property gate) and the runtime `render-gate-bundle` download |
| [abap2UI5](https://github.com/abap2UI5/abap2UI5) | Defines `z2ui5_cl_ai_xml`, the builder whose chains `lib/reconstruct.mjs` re-executes |
