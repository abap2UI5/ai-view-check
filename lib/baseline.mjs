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
 * fixing or adding a finding changes it. A STALE entry — one no current
 * finding matches — FAILS the run, the same contract every declared skip in
 * this ecosystem has: a suppression can never quietly outlive what it was
 * suppressing. `--update-baseline` rewrites the file from the current state.
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

const relOf = (cwd, file) => path.relative(cwd, file || '').split(path.sep).join('/');

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
export function applyBaseline(results, baseline, cwd = process.cwd()) {
  const remaining = new Map(baseline);
  let suppressed = 0;
  for (const r of results) {
    const rel = relOf(cwd, r.file);
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
export function buildBaseline(results, cwd = process.cwd()) {
  const map = new Map();
  for (const r of results) {
    const rel = relOf(cwd, r.file);
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
