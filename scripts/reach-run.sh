#!/bin/bash
# Phase 14c's measurement — S_big and S_small in one run, unattended.
#
#   caffeinate -dims scripts/reach-run.sh
#
# The plan is `experiments/reach/plans/project-a-<date>/change_plan.json`, declared and hashed before
# this ran (`experiments/reach/results/task-set-*.json`). It is gitignored (CLAUDE.md #7), so the path
# comes from the environment or the default and is never written into a tracked file.
#
# **It waits for 02:05 local before it starts.** ADR-0083: project-a moves three tests at 00:00 UTC,
# which is 02:00 here in summer, and a run spanning that boundary regresses against its own baseline.
# Starting just after it gives the run the next 24 hours.
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"   # ADR-0049: the project's suite needs its own node
export NODE_OPTIONS=--max-old-space-size=8192               # ADR-0032: tsc on the large project
export SIDECREW_PORTS=8000,8001                             # the 7B at 2 (prompt §4)

cd "$(dirname "$0")/.." || exit 1
PLAN="${PLAN:-experiments/reach/plans/project-a-2026-09-22/change_plan.json}"
EXPECT_SHA="${EXPECT_SHA:-}"
RESULTS=experiments/reach/results
LOG=$RESULTS/run.log
MODEL=qwen2.5-coder-7b-4bit
START_AFTER="${START_AFTER:-02:05}"

mkdir -p "$RESULTS"
: > "$LOG"
say () { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

TMP="${TMPDIR:-/tmp}"; TMP="${TMP%/}"
sweep () {
  local n
  n=$(ls -d "$TMP"/sidecrew-fix-* "$TMP"/sidecrew-task-* "$TMP"/sidecrew-nm-* 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] && echo "sweeping $n leftover sandbox(es)" | tee -a "$LOG"
  rm -rf "$TMP"/sidecrew-fix-* "$TMP"/sidecrew-task-* "$TMP"/sidecrew-nm-* 2>/dev/null
  return 0
}
finish () {
  sweep
  node dist/cli.js stop --port 8000 >/dev/null 2>&1
  node dist/cli.js stop --port 8001 >/dev/null 2>&1
  say "workers stopped, sandboxes swept — machine left as found"
}
trap finish EXIT INT TERM

# ── a run that cannot finish should not start ────────────────────────────────────────────────────
[ -f "$PLAN" ] || { say "ABORT — the declared plan is not at $PLAN; do NOT regenerate it"; exit 1; }
if [ -n "$EXPECT_SHA" ]; then
  GOT=$(shasum -a 256 "$PLAN" | cut -d' ' -f1)
  [ "$GOT" = "$EXPECT_SHA" ] || { say "ABORT — the plan's sha256 is $GOT, the declared one is $EXPECT_SHA"; exit 1; }
  say "plan sha256 matches the declared task set"
fi
if [ -n "$(git status --porcelain)" ]; then
  say "ABORT — the tree is dirty; a harness compiles uncommitted edits into the run invisibly"; exit 1
fi
PROJECT=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['project'])" "$PLAN")
if [ -n "$(git -C "$PROJECT" status --porcelain)" ]; then
  say "ABORT — the project's tree is dirty"; exit 1
fi
say "sidecrew $(git rev-parse HEAD) · project $(git -C "$PROJECT" rev-parse HEAD)"

# ── wait for the boundary to pass ────────────────────────────────────────────────────────────────
now=$(date +%s)
target=$(date -j -f "%Y-%m-%d %H:%M" "$(date +%Y-%m-%d) $START_AFTER" +%s)
[ "$target" -lt "$now" ] && [ $((now - target)) -gt $((20 * 3600)) ] && target=$((target + 86400))
if [ "$target" -gt "$now" ] && [ $((target - now)) -lt $((20 * 3600)) ]; then
  say "waiting until $START_AFTER local so the run does not span 00:00 UTC (ADR-0083)"
  sleep $((target - now))
fi
say "starting at $(date '+%H:%M') local, $(date -u '+%H:%M') UTC"

# The project may have moved while this slept; the declared set is about the commit above.
if [ -n "$(git -C "$PROJECT" status --porcelain)" ]; then say "ABORT — the project's tree went dirty while waiting"; exit 1; fi

FREE_GB=$(df -g . | awk 'NR==2 {print $4}')
if [ "${FREE_GB:-0}" -lt 20 ]; then say "ABORT — ${FREE_GB} GB free; the sandboxes need room"; exit 1; fi
sweep
node dist/cli.js doctor --project "$PROJECT" 2>&1 | sed -E "s#$HOME#~#g" | grep -E "memory|pressure|swap|tier" | tee -a "$LOG"

# ── the workers ──────────────────────────────────────────────────────────────────────────────────
node dist/cli.js stop --port 8000 >/dev/null 2>&1
node dist/cli.js stop --port 8001 >/dev/null 2>&1
for port in 8000 8001; do
  say "starting $MODEL on :$port"
  nohup node dist/cli.js serve --model "$MODEL" --port "$port" --wait 3600 >> "$RESULTS/serve-$port.log" 2>&1 &
done
up () { node dist/cli.js status --port "$1" --json 2>/dev/null | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['worker']['up'] else 1)" 2>/dev/null; }
for _ in $(seq 1 240); do sleep 15; up 8000 && up 8001 && break; done
if ! up 8000 || ! up 8001; then say "ABORT — both workers did not come up within an hour"; exit 1; fi
say "both workers up"

# ── the run ──────────────────────────────────────────────────────────────────────────────────────
say "── 14c: the declared task set, concurrency 2, correction off, gate at its defaults ──"
node dist/cli.js fix "$PLAN" --concurrency 2 >> "$LOG" 2>&1
say "fix exited $?"
node dist/cli.js fix --report --json > "$RESULTS/run-report.json" 2>&1
say "DONE — report in $RESULTS/run-report.json (gitignored: it carries the run id)"
