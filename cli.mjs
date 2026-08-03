#!/usr/bin/env node
/*
 * abap2ui5-linter — validate abap2UI5 views without an SAP system.
 *
 *   npx abap2ui5-linter [paths...] [options]        (alias: abap2ui5lint)
 *
 * Paths are files or directories (default: ./src). Checked are ABAP classes
 * building views with z2ui5_cl_ai_xml, plus raw *.view.xml / *.fragment.xml.
 *
 * Gates:
 *   properties  every control/member written in the view against the UI5
 *               metadata snapshot (@since floor + deprecation)
 *   render      headless XMLView.create against the local OpenUI5 runtime
 *               with a typed mock model derived from the class
 *
 * Options:
 *   --ui5 <ver>        the UI5 version to check against - the version your
 *                      system runs (default 1.71, alias --min-ui5). Controls and
 *                      members introduced later are reported, as are
 *                      deprecations already in effect at that version.
 *   --distribution <d>  sapui5 (default) or openui5 - which distribution the
 *                      target system serves. On openui5, controls from
 *                      SAPUI5-only libraries (sap.ui.comp, sap.suite.*, ...)
 *                      are reported: they are simply not there. --openui5 is
 *                      a shorthand.
 *   --allow <name>     allow a control or control.member despite the floor
 *                      (repeatable, e.g. --allow sap.m.Avatar.displaySize)
 *   --fail-on <level>  lowest severity that fails the build: error, warning
 *                      (default), hint, or never. Every finding is always
 *                      reported - this only decides the exit code.
 *   --format <f>       stylish (default), json or markdown. --json is a
 *                      shorthand for --format json.
 *   --fix              rewrite what can be corrected mechanically (an obsolete
 *                      binder, an unwrapped ABAP boolean, a t_arg missing its
 *                      $), then report what is left. ABAP2UI5LINT_FIX_DRY_RUN=true
 *                      reports what it would change without touching a file.
 *   --quiet            report errors only - the counts still show everything
 *   --annotate         emit GitHub workflow commands so findings show up on
 *                      the pull request diff (default inside GitHub Actions;
 *                      --no-annotate switches it off). Alongside the stylish
 *                      report only - json and markdown stay parseable.
 *   --no-render        skip the render gate (no browser/@openui5 needed)
 *   --no-properties    skip the property gate
 *   --advisory         report only, always exit 0 (same as --fail-on never)
 *   --verbose          print reconstruction notes
 *   --config <file>    read settings from this abap2ui5lint.jsonc; without the
 *                      flag the file is searched upward from the current
 *                      directory and from each given path (eslint-style).
 *                      Precedence: explicit CLI flag > config file > default.
 *   --no-config        ignore any config file
 *   --version, -v      print version and script location
 *
 * A single line can waive a rule where it stands, ui5lint-style:
 *   " abap2ui5lint-disable-next-line unknown-binding-path -- filled in a LOOP
 *
 * Exit codes: 0 clean, 1 findings at or above --fail-on, 2 bad usage/config.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkFiles, collectFiles } from './lib/index.mjs';
import { findConfig, loadConfig, applyConfig } from './lib/config.mjs';
import { snapshotVersion } from './lib/properties.mjs';
import { SEVERITIES, severityRank, severityOf } from './lib/findings.mjs';
import { applyFixes } from './lib/fix.mjs';
import { FORMATS, summarize, contextLine, formatStylish, formatJson, formatMarkdown, githubAnnotations } from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: abap2ui5-linter [paths...] [--ui5 1.71] [--distribution sapui5|openui5] '
  + '[--allow control[.member]] [--fail-on error|warning|hint|never] [--format stylish|json|markdown] '
  + '[--fix] [--quiet] [--annotate|--no-annotate] [--no-render] [--no-properties] [--advisory] [--verbose] '
  + '[--config abap2ui5lint.jsonc] [--no-config] [--version]';

const die = (message) => {
  console.error(`abap2ui5-linter: ${message}`);
  process.exit(2);
};

const args = process.argv.slice(2);
const opt = {
  minUi5: '1.71', distribution: 'sapui5', allow: [], render: true, properties: true,
  failOn: 'warning', rules: {}, verbose: false,
  format: 'stylish', quiet: false, fix: false,
  // inside a workflow the annotations are the point of running the linter at
  // all: they put a finding on the diff instead of into a collapsed log
  annotate: process.env.GITHUB_ACTIONS === 'true',
};
const seen = new Set(); // options the CLI set explicitly - they beat the config
const paths = [];
let configFlag = null;
let noConfig = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  // a flag that takes a value must actually have one - `--allow` as the last
  // argument would otherwise push undefined and crash deep in the gate
  const value = () => {
    if (i + 1 >= args.length) die(`${a} needs a value\n${USAGE}`);
    return args[++i];
  };
  if (a === '--min-ui5' || a === '--ui5') { opt.minUi5 = value(); seen.add('minUi5'); }
  else if (a === '--distribution') { opt.distribution = value().toLowerCase(); seen.add('distribution'); }
  else if (a === '--openui5') { opt.distribution = 'openui5'; seen.add('distribution'); }
  else if (a === '--allow') opt.allow.push(value());
  else if (a === '--no-render') { opt.render = false; seen.add('render'); }
  else if (a === '--no-properties') { opt.properties = false; seen.add('properties'); }
  else if (a === '--advisory') { opt.failOn = 'never'; seen.add('failOn'); }
  else if (a === '--config') configFlag = value();
  else if (a === '--no-config') noConfig = true;
  else if (a === '--quiet') opt.quiet = true;
  else if (a === '--fix') opt.fix = true;
  else if (a === '--annotate') opt.annotate = true;
  else if (a === '--no-annotate') opt.annotate = false;
  else if (a === '--json') opt.format = 'json';
  else if (a === '--format') {
    const format = value().toLowerCase();
    if (!FORMATS.includes(format)) die(`--format takes ${FORMATS.join(', ')} (got '${format}')`);
    opt.format = format;
  }
  else if (a === '--fail-on') {
    const level = value().toLowerCase();
    if (![...SEVERITIES, 'never'].includes(level)) die(`--fail-on takes ${SEVERITIES.join(', ')} or never (got '${level}')`);
    opt.failOn = level;
    seen.add('failOn');
  }
  else if (a === '--verbose') opt.verbose = true;
  else if (a === '--version' || a === '-v') {
    const { version } = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
    console.log(`abap2ui5-linter ${version} (${path.join(HERE, 'cli.mjs')})`);
    process.exit(0);
  }
  else if (a === '--help' || a === '-h') {
    console.log(USAGE);
    process.exit(0);
  } else if (a.startsWith('-')) die(`unknown option '${a}'\n${USAGE}`);
  else paths.push(a);
}

// abap2ui5lint.jsonc - the committed settings of the checked repo
if (!noConfig) {
  const configFile = configFlag ?? findConfig(process.cwd(), paths);
  if (configFlag || configFile) {
    let cfg;
    try {
      cfg = loadConfig(configFile);
    } catch (e) {
      die(e.message);
    }
    applyConfig(opt, seen, cfg);
    if (!paths.length && cfg.paths) {
      const base = path.dirname(configFile);
      paths.push(...cfg.paths.map((p) => (path.isAbsolute(p) ? p : path.join(base, p))));
    }
  }
}
if (!paths.length) paths.push('src');

let files;
try {
  files = collectFiles(paths);
} catch (e) {
  // a mistyped path is bad usage, not a crash - exit 2 with one clean line
  die(e.code === 'ENOENT' ? `no such file or directory: ${e.path}` : e.message);
}
if (!files.length) {
  if (opt.format === 'json') {
    // the same shape a real run prints - built by the one formatter, so the
    // frozen --json contract cannot drift between the two paths
    console.log(formatJson([], { ...summarize([]), failing: 0 }, opt));
  } else {
    console.log(`abap2ui5-linter: no checkable files under ${paths.join(', ')} (ABAP classes using z2ui5_cl_ai_xml, *.view.xml, *.fragment.xml)`);
  }
  process.exit(0);
}

/* --fix is a pass of its own: the property gate alone (a fix never depends on
 * the render result), rewrite, then the normal run reports what is left -
 * which is what makes `--fix` safe to put in front of any other flag. */
if (opt.fix) {
  const dryRun = process.env.ABAP2UI5LINT_FIX_DRY_RUN === 'true';
  let files_ = 0;
  let fixed = 0;
  let deferred = 0;
  for (const r of await checkFiles(files, { ...opt, render: false })) {
    const source = fs.readFileSync(r.file, 'utf8');
    const result = applyFixes(source, r.findings);
    deferred += result.deferred;
    if (!result.applied) continue;
    files_++;
    fixed += result.applied;
    if (!dryRun) fs.writeFileSync(r.file, result.output);
  }
  if (fixed && opt.format === 'stylish') {
    console.log(`${dryRun ? 'would fix' : 'fixed'} ${fixed} problem(s) in ${files_} file(s)` +
      `${deferred ? `, ${deferred} deferred to the next run (overlapping)` : ''}\n`);
  }
}

const results = await checkFiles(files, opt);

const threshold = opt.failOn === 'never' ? Infinity : severityRank(opt.failOn);
/** Findings at or above the threshold decide the exit code - a hint never
 *  breaks a build unless it was asked to. Render errors always count: the
 *  view demonstrably did not load. */
const failsBuild = (r) =>
  r.renderErrors.length > 0 || r.findings.some((f) => severityRank(severityOf(f)) >= threshold);

const summary = summarize(results);
summary.failing = results.filter(failsBuild).length;
const context = contextLine(opt, summary, snapshotVersion());

if (opt.format === 'json') console.log(formatJson(results, summary, opt));
else if (opt.format === 'markdown') console.log(formatMarkdown(results, summary, { ...opt, context }));
else console.log(formatStylish(results, summary, { ...opt, context }));

if (opt.verbose && opt.format === 'stylish') {
  for (const r of results) {
    for (const n of r.notes) console.log(`note: ${path.relative(process.cwd(), r.file)}: ${n}`);
  }
}

/* Annotations ride ALONGSIDE the human report, never inside a machine-readable
 * one: `--format json` exists to be piped into something, and a workflow
 * command appended after the document turns that document into a parse error.
 * Inside Actions the default is on, so `--json | jq` in a workflow would have
 * broken without this - which is exactly how CI found it. */
if (opt.annotate && opt.format === 'stylish') {
  for (const line of githubAnnotations(results, opt)) console.log(line);
}

if (summary.failing > 0) process.exit(1);
