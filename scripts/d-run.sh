#!/bin/bash
# ADR-0082 D's run: workload #1 on every module whose exemplar survived verification, 7B × 2.
#
#   WATCH=<owner's working checkout> CLONE=<pinned clone> caffeinate -dims scripts/d-run.sh
#
# A module whose exemplar did not verify is skipped here and counted as not surviving by
# `results-d.py` (`prompts/adr-0082-d.md` §1 amendments). Workload #1 has no suite baseline, so ADR-0083's
# 02:00 boundary does not bind; a quiet machine does. Both trees are fingerprinted before and after,
# and `runBatch` also checks the clone itself (ADR-0088).
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" NODE_OPTIONS=--max-old-space-size=8192
export SIDECREW_PORTS=8000,8001
cd "$(dirname "$0")/.." || exit 1
OUT=experiments/test-first/results; LOG=$OUT/d-run.log; : > "$LOG"
MODEL=qwen2.5-coder-7b-4bit
say () { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
fp () { ( cd "$1" && git rev-parse HEAD; git status --porcelain --untracked-files=all | shasum -a 256
  for f in package.json yarn.lock package-lock.json; do [ -f "$f" ] && shasum -a 256 "$f"; done
  ls -A node_modules | shasum -a 256 ) 2>/dev/null; }
finish () { node dist/cli.js stop --port 8000 >/dev/null 2>&1; node dist/cli.js stop --port 8001 >/dev/null 2>&1; say "workers stopped"; }
trap finish EXIT INT TERM

[ -n "$(git status --porcelain)" ] && { say "ABORT — sidecrew tree is dirty"; exit 1; }
[ -n "$(git -C "$CLONE" status --porcelain)" ] && { say "ABORT — the clone is dirty"; exit 1; }
say "sidecrew $(git rev-parse HEAD) · clone $(git -C "$CLONE" rev-parse HEAD)"
fp "$WATCH" > "$OUT/d-watch-before.txt"; fp "$CLONE" > "$OUT/d-clone-before.txt"

for port in 8000 8001; do nohup node dist/cli.js serve --model "$MODEL" --port "$port" --wait 3600 >> "$OUT/serve-$port.log" 2>&1 & done
up () { node dist/cli.js status --port "$1" --json 2>/dev/null | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['worker']['up'] else 1)" 2>/dev/null; }
for _ in $(seq 1 240); do sleep 15; up 8000 && up 8001 && break; done
up 8000 && up 8001 || { say "ABORT — workers did not come up"; exit 1; }
say "both workers up"

for plan in experiments/test-first/plans/m*/test_plan.json; do
  m=$(basename "$(dirname "$plan")")
  valid=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('valid', False))" "$OUT/$m-validate.json" 2>/dev/null)
  if [ "$valid" != "True" ]; then say "$m: skipped — its exemplar did not verify"; continue; fi
  t0=$(date +%s)
  node dist/cli.js run "$plan" --concurrency 2 --json > "$OUT/$m-run.json" 2>> "$LOG"
  say "$m: exit $? · $(( $(date +%s) - t0 )) s · $(python3 -c "import json,sys; r=json.load(open(sys.argv[1])); s=r['stats']; print(f\"{s['survived']}/{s['tasks']} survived\")" "$OUT/$m-run.json" 2>/dev/null)"
  echo "$m $(( $(date +%s) - t0 ))" >> "$OUT/d-wall.txt"
done

fp "$WATCH" > "$OUT/d-watch-after.txt"; fp "$CLONE" > "$OUT/d-clone-after.txt"
cmp -s "$OUT/d-watch-before.txt" "$OUT/d-watch-after.txt" && say "working checkout: IDENTICAL" || say "working checkout: CHANGED"
cmp -s "$OUT/d-clone-before.txt" "$OUT/d-clone-after.txt" && say "clone: IDENTICAL" || say "clone: CHANGED"
say "DONE"
