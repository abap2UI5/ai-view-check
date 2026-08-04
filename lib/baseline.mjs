/*
 * baseline — adopt the linter on a repo that already has findings.
 *
 * Switching a linter on over an existing codebase produces everything at
 * once, and the only escapes so far lost information: `rules: false` switches
 * a rule off wholesale, a directive touches every line. The baseline is the
 * third way, the one abaplint and this ecosystem's own pattern-lint use: a
 * committed file that says "these findings existed when we adopted the
 * linter". Baselined findings are suppressed (counted, never listed), NEW
 * findings fail normally — so the debt is frozen, not ignored.
 *
 * The key is deliberately line-free (`file|rule|control|member|value` with a
 * COUNT per key): moving code around does not invalidate the baseline, only
 * fixing or adding a finding changes it. File paths in the keys are relative
 * to the BASELINE FILE's directory, not to whatever cwd a run happens to
 * have — so the CLI from any directory, the Action and the VS Code extension
 * all compute identical keys. A STALE entry — one no current finding matches
 * — FAILS the run, the same contract every declared skip in this ecosystem
 * has: a suppression can never quietly outlive what it was suppressing.
 * `--update-baseline` rewrites the file from the current state.
 *
 * Render errors are not baselineable: their message text is unstable and
 * `rules['render-error']` already waives them per file.
 */
import fs from 'fs';
import path from 'path';

/** The stable identity of a finding — no line, so moved code stays matched. */
export function findingKey(relativeFile, f) {
  return [relativeFile, f.type, f.control || '', f.member || '', f.value || ''].join('|');
}

const relOf = (baseDir, file) => path.relative(baseDir, file || '').split(path.sep).join('/');

/** The directory keys are computed against: where the baseline file lives. */
export const baselineBase = (file) => path.dirname(path.resolve(file));

/** Parse a baseline file into key -> count. Throws with a precise message. */
export function loadBaseline(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: not a valid baseline file - ${e.message}`);
  }
  if (typeof raw.findings !== 'object' || raw.findings === null || Array.isArray(raw.findings)) {
    throw new Error(`${file}: 'findings' must be an object of finding-key -> count`);
  }
  const map = new Map();
  for (const [k, n] of Object.entries(raw.findings)) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`${file}: findings['${k}'] must be a positive integer count`);
    map.set(k, n);
  }
  return map;
}

/**
 * Drop the findings the baseline covers (mutates each result's findings).
 * Returns { suppressed, stale } — stale entries are the caller's to fail on.
 */
export function applyBaseline(results, baseline, baseDir = process.cwd()) {
  const remaining = new Map(baseline);
  let suppressed = 0;
  for (const r of results) {
    const rel = relOf(baseDir, r.file);
    r.findings = r.findings.filter((f) => {
      const key = findingKey(rel, f);
      const n = remaining.get(key) || 0;
      if (n > 0) {
        remaining.set(key, n - 1);
        suppressed++;
        return false;
      }
      return true;
    });
  }
  const stale = [...remaining.entries()]
    .filter(([, n]) => n > 0)
    .map(([key, count]) => ({ key, count }));
  return { suppressed, stale };
}

/** The current findings as a baseline map (post-settle, pre-baseline). */
export function buildBaseline(results, baseDir = process.cwd()) {
  const map = new Map();
  for (const r of results) {
    const rel = relOf(baseDir, r.file);
    for (const f of r.findings) {
      const key = findingKey(rel, f);
      map.set(key, (map.get(key) || 0) + 1);
    }
  }
  return map;
}

/** Write a baseline map, keys sorted so the diff of an update stays readable. */
export function writeBaseline(file, map) {
  const findings = {};
  for (const key of [...map.keys()].sort()) findings[key] = map.get(key);
  fs.writeFileSync(file, `${JSON.stringify({
    note: 'abap2ui5-linter baseline: findings that existed when the linter was adopted. Suppressed on every run; NEW findings still fail, a STALE entry fails too. Regenerate with --update-baseline.',
    findings,
  }, null, 2)}\n`);
}
