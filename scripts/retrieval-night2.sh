#!/bin/bash
# Phase 14d, the second night — finish what the first could not (`prompts/phase-14d-retrieval.md`, notes of
# 25 Sep ~05:30 and ~10:00).
#
#   T_BASE_N12=… T_RETR_N12=… T_BASE_N40=… T_RETR_N40=… WATCH=<working checkout> \
#     caffeinate -dims scripts/retrieval-night2.sh
#
# 1. Waits for 02:05 local (ADR-0083).
# 2. Re-runs the retrieval N≈40 arm **whole**, at concurrency 1 on one 7B worker. The first attempt was
#    interrupted at 09:54 on 25 Sep while the machine swapped 30 GB; its partial run is kept on disk and
#    recorded as `retr-n40-interrupted`, and nothing in it is used.
# 3. Re-gates every arm's machine failures once, at concurrency 1 (`scripts/retrieval-regate.sh`).
# 4. Applies the frozen rule (`scripts/results-14d.py`).
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
export NODE_OPTIONS=--max-old-space-size=8192
export SIDECREW_PORTS=8000

cd "$(dirname "$0")/.." || exit 1
DATE="${DATE:-2026-09-25}"
PLANS_DIR=experiments/planner-cost/plans
MAP=$PLANS_DIR/run-14d-$DATE-dirs.json
LOG=$PLANS_DIR/night2-14d-$DATE.log
PLAN=$PLANS_DIR/project-a-$DATE-retr-n40/change_plan.json
MODEL=qwen2.5-coder-7b-4bit
START_AFTER="${START_AFTER:-02:05}"
: > "$LOG"
say () { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
TMP="${TMPDIR:-/tmp}"; TMP="${TMP%/}"
sweep () { rm -rf "$TMP"/sidecrew-fix-* "$TMP"/sidecrew-task-* "$TMP"/sidecrew-nm-* 2>/dev/null; return 0; }
trap 'sweep; node dist/cli.js stop --port 8000 >/dev/null 2>&1; say "worker stopped, sandboxes swept"' EXIT INT TERM

for v in T_BASE_N12 T_RETR_N12 T_BASE_N40 T_RETR_N40; do
  [ -n "${!v:-}" ] && [ -f "${!v}" ] || { say "ABORT — $v must name that planner's transcript"; exit 1; }
done
[ -z "$(git status --porcelain)" ] || { say "ABORT — the tree is dirty; the harness would run uncommitted code"; exit 1; }
[ -f "$PLAN" ] || { say "ABORT — no plan at $PLAN"; exit 1; }
say "plan $(shasum -a 256 "$PLAN" | cut -d' ' -f1) (must equal the first night's retr-n40 line in run-14d-$DATE.log)"
PROJECT=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['project'])" "$PLAN")
[ -z "$(git -C "$PROJECT" status --porcelain)" ] || { say "ABORT — the clone is dirty"; exit 1; }
say "sidecrew $(git rev-parse HEAD) · project $(git -C "$PROJECT" rev-parse HEAD)"

fingerprint () {
  ( cd "$1" && git rev-parse HEAD; git status --porcelain --untracked-files=all | shasum -a 256
    for f in package.json package-lock.json yarn.lock pnpm-lock.yaml; do [ -f "$f" ] && shasum -a 256 "$f"; done
    ls -A node_modules | shasum -a 256; ls -A node_modules/.bin | shasum -a 256 ) 2>/dev/null
}

now=$(date +%s)
target=$(date -j -f "%Y-%m-%d %H:%M" "$(date +%Y-%m-%d) $START_AFTER" +%s)
if [ "$target" -gt "$now" ] && [ $((target - now)) -lt $((20 * 3600)) ]; then
  say "waiting until $START_AFTER local (ADR-0083)"; sleep $((target - now))
fi
say "starting at $(date '+%H:%M') local, $(date -u '+%H:%M') UTC"
[ -n "${WATCH:-}" ] && fingerprint "$WATCH" > "$PLANS_DIR/watch-before-night2.txt"
fingerprint "$PROJECT" > "$PLANS_DIR/clone-before-night2.txt"

# ── 2. the retrieval N≈40 arm, whole, at concurrency 1 ─────────────────────────────────────────────
node dist/cli.js stop --port 8000 >/dev/null 2>&1
nohup node dist/cli.js serve --model "$MODEL" --port 8000 --wait 3600 >> "$PLANS_DIR/serve-night2.log" 2>&1 &
up () { node dist/cli.js status --port 8000 --json 2>/dev/null | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['worker']['up'] else 1)" 2>/dev/null; }
for _ in $(seq 1 120); do sleep 15; up && break; done
up || { say "ABORT — the worker did not come up"; exit 1; }
before=$(ls -1 .sidecrew/runs | sort | tail -1)
say "── retr-n40, whole, concurrency 1 ──"
node dist/cli.js fix "$PLAN" --concurrency 1 >> "$LOG" 2>&1
say "retr-n40: fix exited $?"
after=$(ls -1 .sidecrew/runs | sort | tail -1)
[ "$after" = "$before" ] && { say "ABORT — no new run directory"; exit 1; }
python3 - "$MAP" "$after" <<'EOF'
import json, sys
path, new = sys.argv[1:]
m = json.load(open(path))
m["retr-n40-interrupted"] = m["retr-n40"]
m["retr-n40"] = new
json.dump(m, open(path, "w"), indent=2)
EOF
node dist/cli.js stop --port 8000 >/dev/null 2>&1
sweep

# ── 3. re-gate the machine failures of every arm ────────────────────────────────────────────────────
scripts/retrieval-regate.sh >> "$LOG" 2>&1
say "re-gate exited $?"

# ── 4. the frozen rule ────────────────────────────────────────────────────────────────────────────
python3 scripts/results-14d.py --date "$DATE" >> "$LOG" 2>&1
say "results exited $? — experiments/planner-cost/results/result-14d-$DATE.json"

fingerprint "$PROJECT" > "$PLANS_DIR/clone-after-night2.txt"
cmp -s "$PLANS_DIR/clone-before-night2.txt" "$PLANS_DIR/clone-after-night2.txt" && say "clone: IDENTICAL (ADR-0088)" || say "clone: CHANGED — ADR-0088 breach"
if [ -n "${WATCH:-}" ]; then
  fingerprint "$WATCH" > "$PLANS_DIR/watch-after-night2.txt"
  cmp -s "$PLANS_DIR/watch-before-night2.txt" "$PLANS_DIR/watch-after-night2.txt" && say "working checkout: IDENTICAL" || say "working checkout: CHANGED — see watch-*-night2.txt"
fi
say "DONE"
