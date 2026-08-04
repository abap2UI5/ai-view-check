/*
 * fix — apply the fixes a finding brought with it.
 *
 * A rule attaches `fixes: [{ start, end, text }]` — exact character spans in
 * the source it was given — when, and only when, the correction is
 * mechanical: the same call with the current method name, a missing `$`, a
 * bare boolean token wrapped. A rule whose correction needs a decision (which
 * of two duplicate attributes survives, what event a `_bind` on an event slot
 * should raise) deliberately carries none: a fix that has to guess is worse
 * than a finding that stays.
 *
 * Suppression happens before this: `--fix` works off the findings that
 * survived the `rules` block and the source directives, so a waived line is
 * never rewritten.
 */

/** Rule ids that can carry a fix — for the docs and the rules page. */
export const FIXABLE = Object.freeze(['obsolete-binder', 'unconverted-abap-boolean', 'event-arg-unresolved', 'popover-display-val', 'undeclared-namespace']);

export const isFixable = (finding) => Boolean(finding?.fixes?.length);

/**
 * Rewrite `source` with every fix the findings carry. Overlapping spans are
 * left for the next run rather than resolved by guesswork — `--fix` is
 * expected to be run until it reports nothing, exactly like its neighbours.
 *
 * Returns { output, applied, deferred }.
 */
export function applyFixes(source, findings) {
  const edits = findings
    .flatMap((f) => f.fixes ?? [])
    .filter((e) => Number.isInteger(e.start) && Number.isInteger(e.end) && e.start >= 0 && e.end <= source.length && e.start <= e.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  let out = '';
  let cursor = 0;
  let applied = 0;
  let deferred = 0;
  for (const e of edits) {
    if (e.start < cursor) { deferred++; continue; }
    out += source.slice(cursor, e.start) + e.text;
    cursor = e.end;
    applied++;
  }
  return { output: out + source.slice(cursor), applied, deferred };
}
