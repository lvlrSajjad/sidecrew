#!/bin/bash
# A measurement's copy of a project at one commit — ADR-0088's addendum.
#
#   scripts/pinned-clone.sh <project-dir> <commit> <dest>
#
# The owner's working checkout is also the testbed, and it moves (36 commits in one day on 23 Sep).
# A measurement runs on this clone instead, so it can neither be disturbed by the day's work nor disturb
# it. The working checkout is only ever read: `git clone --local` copies its objects, and its
# `node_modules` is APFS-cloned (`cp -c`: instant, blocks shared, nothing downloaded).
#
# **It refuses when the dependency manifests at <commit> differ from the working checkout's**, because
# then the copied `node_modules` would be the wrong one for the pinned tree, and a verdict would be
# about packages the commit never used. Delete the clone after the measurement.
set -eu
SRC="$1"; COMMIT="$2"; DEST="$3"
[ -e "$DEST" ] && { echo "refusing: $DEST already exists — delete it first"; exit 1; }

for f in package.json yarn.lock package-lock.json pnpm-lock.yaml npm-shrinkwrap.json; do
  if git -C "$SRC" cat-file -e "$COMMIT:$f" 2>/dev/null || [ -f "$SRC/$f" ]; then
    if ! cmp -s <(git -C "$SRC" show "$COMMIT:$f" 2>/dev/null) "$SRC/$f" 2>/dev/null; then
      echo "refusing: $f at $COMMIT differs from the working checkout's, so its node_modules is not this commit's"
      exit 1
    fi
  fi
done

mkdir -p "$(dirname "$DEST")"
git clone -q --local --no-hardlinks "$SRC" "$DEST"
git -C "$DEST" checkout -q "$COMMIT"
cp -Rc "$SRC/node_modules" "$DEST/node_modules"
[ -z "$(git -C "$DEST" status --porcelain)" ] || { echo "the clone is not clean after setup"; exit 1; }
echo "clone ready: $(git -C "$DEST" rev-parse HEAD)"
