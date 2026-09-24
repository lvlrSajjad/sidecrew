#!/bin/bash
# ADR-0082 D: verify every planned exemplar survives the real gate before the run (workload #1's rule:
# an exemplar the gate refuses teaches the worker to fail). `sidecrew plan` per module, serially.
#
#   WATCH=<owner's working checkout> CLONE=<pinned clone> scripts/d-verify-exemplars.sh
#
# Heavy (Stryker per exemplar): only on a quiet machine. Both trees are fingerprinted before and after.
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" NODE_OPTIONS=--max-old-space-size=8192
cd "$(dirname "$0")/.." || exit 1
OUT=experiments/test-first/results; mkdir -p "$OUT"; LOG=$OUT/verify-exemplars.log; : > "$LOG"
say () { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
fp () { ( cd "$1" && git rev-parse HEAD; git status --porcelain --untracked-files=all | shasum -a 256
  for f in package.json yarn.lock package-lock.json; do [ -f "$f" ] && shasum -a 256 "$f"; done
  ls -A node_modules | shasum -a 256 ) 2>/dev/null; }
[ -n "$(git status --porcelain)" ] && { say "ABORT — sidecrew tree is dirty"; exit 1; }
fp "$WATCH" > "$OUT/watch-before.txt"; fp "$CLONE" > "$OUT/clone-before.txt"
for plan in experiments/test-first/plans/m*/test_plan.json; do
  m=$(basename "$(dirname "$plan")")
  node dist/cli.js plan "$plan" --json > "$OUT/$m-validate.json" 2>> "$LOG"
  say "$m: exit $? · $(python3 -c "import json,sys; r=json.load(open(sys.argv[1])); print('valid' if r.get('valid') else 'INVALID', [e.get('code') for e in r.get('errors',[])])" "$OUT/$m-validate.json" 2>/dev/null)"
done
fp "$WATCH" > "$OUT/watch-after.txt"; fp "$CLONE" > "$OUT/clone-after.txt"
cmp -s "$OUT/watch-before.txt" "$OUT/watch-after.txt" && say "working checkout: IDENTICAL" || say "working checkout: CHANGED"
cmp -s "$OUT/clone-before.txt" "$OUT/clone-after.txt" && say "clone: IDENTICAL" || say "clone: CHANGED"
say "DONE"
