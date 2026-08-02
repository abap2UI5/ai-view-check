#!/usr/bin/env bash
#
# substitute-linter.sh <linter-checkout> <consumer-checkout>
#
# Replaces the linter a consumer installed from its pinned commit with the
# working copy in <linter-checkout>, so the downstream workflow tests the
# PROPOSED linter rather than the pinned one.
#
# Only the files the package actually publishes are copied - the `files` list
# in package.json is read rather than restated here, so adding a published
# directory cannot silently leave this script behind. The consumer's install
# is otherwise untouched: the linter's own runtime dependencies (@openui5/*,
# playwright) stay hoisted at the consumer's top level, which is why a plain
# file copy is enough and no second install is needed.
set -euo pipefail

# Absolute, because `require()` reads a bare relative path as a module name.
LINTER=$(cd "${1:?usage: substitute-linter.sh <linter-checkout> <consumer-checkout>}" && pwd)
CONSUMER=$(cd "${2:?usage: substitute-linter.sh <linter-checkout> <consumer-checkout>}" && pwd)

TARGET="$CONSUMER/node_modules/@abap2ui5/linter"

if [ ! -d "$TARGET" ]; then
  echo "::error::$TARGET does not exist - did the consumer's install run, and does it still depend on @abap2ui5/linter?"
  exit 1
fi

PINNED=$(node -p "
  try { require('$CONSUMER/package-lock.json').packages['node_modules/@abap2ui5/linter'].resolved }
  catch { 'unknown' }
")
echo "consumer pins: $PINNED"
echo "substituting:  $(git -C "$LINTER" rev-parse HEAD)"

# package.json comes along so the `exports` map and `bin` entries stay right.
FILES=$(node -p "
  const p = require('$LINTER/package.json');
  [...new Set([...(p.files || []), 'package.json'])].join('\n');
")

rm -rf "$TARGET"
mkdir -p "$TARGET"
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  entry=${entry%/}
  if [ -e "$LINTER/$entry" ]; then
    # Copy to the SAME relative path: a files[] entry may name a file inside a
    # directory ("scripts/generate-metadata.mjs"), which a copy into $TARGET/
    # would flatten into the package root.
    mkdir -p "$(dirname "$TARGET/$entry")"
    cp -R "$LINTER/$entry" "$TARGET/$entry"
  else
    echo "note: '$entry' is listed in files[] but absent from the checkout - skipped"
  fi
done <<< "$FILES"

# Prove the substitution took rather than trusting the copy: the entry point
# the consumer imports has to be byte-identical to this checkout's.
for f in lib/index.mjs data/properties.json; do
  if ! cmp -s "$LINTER/$f" "$TARGET/$f"; then
    echo "::error::$f in $TARGET does not match $LINTER - the substitution did not take"
    exit 1
  fi
done

echo "substituted linter in place: $TARGET"
