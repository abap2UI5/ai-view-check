/*
 * report — turning results into the output a user reads.
 *
 * The shape is deliberately the one ui5lint and abaplint users already know,
 * because they are the same people: the file path as a heading, one indented
 * line per problem carrying `line:col`, severity, message and the **rule id**,
 * and a closing `N problems (…)` count. A file with nothing to say is not
 * printed at all — on a corpus of a few hundred views the old per-file `pass`
 * line was the bulk of the output.
 *
 *   formats      stylish (default) | json | markdown
 *   annotations  GitHub workflow commands, so findings land on the diff of a
 *                pull request instead of in the log only
 */
import path from 'path';
import { SEVERITIES, severityOf, describe, RENDER_RULE } from './findings.mjs';

export const FORMATS = ['stylish', 'json', 'markdown', 'sarif'];

/* ── colour ─────────────────────────────────────────────────────────────── */

const ANSI = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', underline: '\x1b[4m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m', green: '\x1b[32m' };

/** NO_COLOR / FORCE_COLOR are honoured before the TTY check — the usual
 *  contract, and what keeps the test output free of escape codes. */
export function colorEnabled(stream = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== '0';
  return Boolean(stream && stream.isTTY);
}

const painter = (on) => (code, text) => (on ? `${ANSI[code]}${text}${ANSI.reset}` : text);

const SEVERITY_COLOR = { error: 'red', warning: 'yellow', hint: 'blue' };

/* ── problems ───────────────────────────────────────────────────────────── */

/**
 * One flat, source-ordered list of what a result has to report: its findings
 * plus the render-gate failures, which get a rule id of their own so every
 * printed line has the same five columns. Problems the gate could not place
 * (a finding inlined from a helper chain) sort last.
 */
export function problemsOf(result) {
  const problems = result.findings.map((f) => ({
    line: f.line,
    column: f.column,
    severity: severityOf(f),
    message: f.message || describe(f),
    rule: f.type,
  }));
  for (const e of result.renderErrors) {
    // rules['render-error'] may have decided a render failure weighs less
    problems.push({ line: undefined, column: undefined, severity: result.renderSeverity ?? 'error', message: String(e).replace(/\s+/g, ' ').slice(0, 220), rule: RENDER_RULE });
  }
  return problems.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity) || (a.column ?? 0) - (b.column ?? 0));
}

/** `--quiet`: report errors only. The summary still counts everything, so a
 *  hidden warning never becomes an invisible one. */
const visible = (problems, quiet) => (quiet ? problems.filter((p) => p.severity === 'error') : problems);

/** Why the render gate was skipped for this file — a notice, not a problem. */
const skipNote = (r) =>
  `${r.helperTokens} builder call(s) in helper methods — not statically reconstructable, render gate skipped`;

/* ── summary ────────────────────────────────────────────────────────────── */

export function summarize(results) {
  const totals = { error: 0, warning: 0, hint: 0 };
  let skipped = 0;
  for (const r of results) {
    for (const p of problemsOf(r)) totals[p.severity]++;
    if (r.skippedRender && !r.findings.length && !r.renderErrors.length) skipped++;
  }
  const problems = totals.error + totals.warning + totals.hint;
  return { files: results.length, skipped, totals, problems };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `6 problems (3 errors, 2 warnings, 1 hint)` — the line both reference
 *  linters close with, and the phrase users grep their CI logs for. */
export function countLine(totals) {
  const problems = totals.error + totals.warning + totals.hint;
  if (!problems) return null;
  const parts = [...SEVERITIES].reverse().map((s) => plural(totals[s], s));
  return `${plural(problems, 'problem')} (${parts.join(', ')})`;
}

/** The run's context: what was checked against, and what breaks the build. */
export function contextLine(opt, summary, snapshot) {
  const target = `${opt.distribution === 'openui5' ? 'OpenUI5' : 'SAPUI5'} ${opt.minUi5}`;
  return `abap2ui5-linter: ${plural(summary.files, 'file')}, ${summary.failing} failing, ${summary.skipped} skipped ` +
    `(target ${target}${snapshot ? `, metadata from ${snapshot}` : ''}, failing on ${opt.failOn})`;
}

/* ── stylish ────────────────────────────────────────────────────────────── */

export function formatStylish(results, summary, opt = {}) {
  const paint = painter(opt.color ?? colorEnabled());
  const out = [];
  for (const r of results) {
    const problems = visible(problemsOf(r), opt.quiet);
    const skipped = r.skippedRender && !r.findings.length && !r.renderErrors.length;
    if (!problems.length && !skipped) continue;
    out.push(paint('underline', path.relative(process.cwd(), r.file ?? '')));
    if (skipped) out.push(`  ${paint('dim', skipNote(r))}`);
    const width = Math.max(0, ...problems.map((p) => (p.line ? `${p.line}:${p.column}`.length : 0)));
    // aligning the rule id keeps the column readable; a single very long
    // message (a render error) must not push it off the screen for the rest
    const msgWidth = Math.min(100, Math.max(0, ...problems.map((p) => p.message.length)));
    for (const p of problems) {
      const where = p.line ? `${p.line}:${p.column}` : '';
      out.push(
        `  ${paint('dim', where.padEnd(width))}  ${paint(SEVERITY_COLOR[p.severity], p.severity.padEnd(7))}  ` +
        `${p.message.padEnd(msgWidth)}  ${paint('dim', p.rule)}`.trimEnd()
      );
    }
    out.push('');
  }
  const counts = countLine(summary.totals);
  out.push(counts
    ? paint(summary.totals.error ? 'red' : 'yellow', counts)
    : paint('green', 'Success! No findings detected.'));
  if (opt.context) out.push(paint('dim', opt.context));
  return out.join('\n');
}

/* ── json ───────────────────────────────────────────────────────────────── */

/** Machine-readable output for tool integrations (the VS Code extension, a
 *  CI collector). `docs` and `model` stay out — they can be megabytes. */
export function formatJson(results, summary, opt = {}) {
  return JSON.stringify({
    files: summary.files,
    failing: summary.failing,
    skipped: summary.skipped,
    problems: summary.problems,
    totals: summary.totals,
    failOn: opt.failOn,
    results: results.map((r) => ({
      file: r.file,
      kind: r.kind,
      usesBuilder: r.usesBuilder ?? true,
      findings: r.findings,
      renderErrors: r.renderErrors,
      // additive: present only when rules['render-error'] set a severity
      ...(r.renderSeverity ? { renderSeverity: r.renderSeverity } : {}),
      skippedRender: r.skippedRender,
      helperTokens: r.helperTokens,
      notes: r.notes,
    })),
  });
}

/* ── markdown ───────────────────────────────────────────────────────────── */

const cell = (s) => String(s).replace(/\|/g, '\\|');

/** For a PR comment or a `$GITHUB_STEP_SUMMARY`. */
export function formatMarkdown(results, summary, opt = {}) {
  const out = ['# abap2UI5-linter', ''];
  out.push(countLine(summary.totals) ? `**${countLine(summary.totals)}**` : '**Success! No findings detected.**', '');
  for (const r of results) {
    const problems = visible(problemsOf(r), opt.quiet);
    const skipped = r.skippedRender && !r.findings.length && !r.renderErrors.length;
    if (!problems.length && !skipped) continue;
    out.push(`### \`${path.relative(process.cwd(), r.file ?? '')}\``, '');
    if (skipped) out.push(`> ${skipNote(r)}`, '');
    if (problems.length) {
      out.push('| Location | Severity | Message | Rule |', '| --- | --- | --- | --- |');
      for (const p of problems) {
        out.push(`| ${p.line ? `${p.line}:${p.column}` : '—'} | ${p.severity} | ${cell(p.message)} | \`${p.rule}\` |`);
      }
      out.push('');
    }
  }
  if (opt.context) out.push(`_${opt.context}_`);
  return out.join('\n');
}

/* ── sarif ──────────────────────────────────────────────────────────────── */

const SARIF_LEVEL = { error: 'error', warning: 'warning', hint: 'note' };

/**
 * SARIF 2.1.0 — the exchange format GitHub code scanning ingests, so findings
 * land in the Security tab and on the PR as native review annotations
 * (`github/codeql-action/upload-sarif` with this file). Like `--json` a
 * machine format: complete (never `--quiet`-filtered) and free of the
 * workflow-command annotations that ride alongside stylish output only.
 */
export function formatSarif(results) {
  const ruleIds = new Set();
  const sarifResults = [];
  for (const r of results) {
    const uri = path.relative(process.cwd(), r.file ?? '').split(path.sep).join('/');
    for (const p of problemsOf(r)) {
      ruleIds.add(p.rule);
      sarifResults.push({
        ruleId: p.rule,
        level: SARIF_LEVEL[p.severity] || 'warning',
        message: { text: p.message },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri },
            ...(p.line ? { region: { startLine: p.line, startColumn: p.column || 1 } } : {}),
          },
        }],
      });
    }
  }
  return JSON.stringify({
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'abap2ui5-linter',
          informationUri: 'https://github.com/abap2UI5/linter',
          rules: [...ruleIds].sort().map((id) => ({
            id,
            helpUri: `https://abap2ui5.github.io/linter/#${id}`,
          })),
        },
      },
      results: sarifResults,
    }],
  });
}

/* ── GitHub annotations ─────────────────────────────────────────────────── */

// https://docs.github.com/actions/reference/workflow-commands-for-github-actions
const escData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

const ANNOTATION_LEVEL = { error: 'error', warning: 'warning', hint: 'notice' };

/**
 * GitHub workflow commands, one per problem — this is what puts a finding on
 * the changed line of a pull request instead of into a log nobody opens. Only
 * placed problems can be annotated on a line; the rest are attached to the
 * file. Emitted alongside the chosen format, never instead of it.
 */
export function githubAnnotations(results, opt = {}) {
  const out = [];
  for (const r of results) {
    const file = path.relative(process.cwd(), r.file ?? '');
    for (const p of visible(problemsOf(r), opt.quiet)) {
      const props = [`file=${escProp(file)}`];
      if (p.line) props.push(`line=${p.line}`, `col=${p.column}`);
      props.push(`title=${escProp(`abap2ui5-linter(${p.rule})`)}`);
      out.push(`::${ANNOTATION_LEVEL[p.severity]} ${props.join(',')}::${escData(p.message)}`);
    }
  }
  return out;
}
