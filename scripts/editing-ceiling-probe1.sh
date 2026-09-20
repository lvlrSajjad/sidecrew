#!/bin/bash
# Phase 14b probe 1 — the 14B on §2.2's 30 declared `null_guard` tasks, unattended.
#
#   caffeinate -i scripts/editing-ceiling-probe1.sh
#
# Only two things differ from the pass-1 run this is compared against: the worker is
# `qwen2.5-coder-14b-4bit` instead of the 7B, and concurrency is 1 because one 14B replaces two 7Bs
# (CLAUDE.md #5). The plan, the gate and `correction.enabled: false` are pass 1's.
#
# The plan is gitignored and lives on one machine (CLAUDE.md #7), so its path is taken from the
# environment or defaulted locally and never written into a tracked file.
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"   # ADR-0049: the project's suite needs its own node
export NODE_OPTIONS=--max-old-space-size=8192               # ADR-0032: tsc on the large project

cd "$(dirname "$0")/.." || exit 1
PLAN="${PLAN:-experiments/correction-round/plans/project-a-2026-09-20/change_plan.json}"
LOG=experiments/editing-ceiling/results/probe1.log
MODEL=qwen2.5-coder-14b-4bit

mkdir -p experiments/editing-ceiling/results
: > "$LOG"
say () { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

# ── leaving the machine as we found it ───────────────────────────────────────────────────────────
# `runFix` deletes its own sandboxes and `verifyChange` each per-task clone; none of that runs if this
# is killed. A project-a sandbox is ~0.5 GB, so an interrupted run is the one way this fills a disk.
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
  # The 14B holds ~8.2 GB. A worker still resident afterwards is 8.2 GB the machine's owner did not
  # ask to donate, and this run is explicitly one that needed them to close things first.
  node dist/cli.js stop >/dev/null 2>&1
  say "worker stopped, sandboxes swept — machine left as found"
}
trap finish EXIT INT TERM
sweep

# ── a run that cannot finish should not start ────────────────────────────────────────────────────
[ -f "$PLAN" ] || { say "ABORT — the declared plan is not at $PLAN. It is gitignored and exists on one machine; do NOT regenerate it (README §2)."; exit 1; }

FREE_GB=$(df -g . | awk 'NR==2 {print $4}')
if [ "${FREE_GB:-0}" -lt 20 ]; then say "ABORT — ${FREE_GB} GB free; the sandboxes need room"; exit 1; fi

if [ -n "$(git status --porcelain)" ]; then
  say "ABORT — the tree is dirty. A tsx/dist harness compiles uncommitted edits into the run with"
  say "        nothing in any log to show it (HANDOFF § Standing hazards)."
  exit 1
fi
say "commit $(git rev-parse HEAD)"

# ADR-0069. The baseline is captured once at the start; a verdict taken on the next calendar day
# against it can lose the whole run, and unlike §2.2 a working probe DOES reach the suite here.
say "local time now $(date '+%H:%M'); worst-case ~5.5 h. Crossing midnight would put ADR-0069 in play."

# ── the worker ───────────────────────────────────────────────────────────────────────────────────
node dist/cli.js stop >/dev/null 2>&1          # no 7B left over from an earlier run: one model at a time
say "starting $MODEL (8.2 GB; --wait queues for free RAM rather than refusing)"
nohup node dist/cli.js serve --model "$MODEL" --wait 3600 >> experiments/editing-ceiling/results/serve-probe1.log 2>&1 &

for _ in $(seq 1 240); do
  sleep 15
  node dist/cli.js status --json 2>/dev/null \
    | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['worker']['up'] else 1)" 2>/dev/null && break
done
if ! node dist/cli.js status --json 2>/dev/null \
     | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['worker']['up'] else 1)" 2>/dev/null; then
  say "ABORT — no worker came up in an hour. Most likely there was never 10.2 GB free (8.2 + headroom)."
  say "        Probe 1 on a swapping machine is the ADR-0066 false negative, so it refuses rather than lying."
  exit 1
fi
node dist/cli.js status --json | tee -a "$LOG"
say "worker is up — confirm the model line above says 14B before trusting anything downstream"

# ── the run ──────────────────────────────────────────────────────────────────────────────────────
say "── probe 1: 30 tasks, concurrency 1, correction off ──"
node dist/cli.js fix "$PLAN" --concurrency 1 >> "$LOG" 2>&1
say "fix exited $?"

node dist/cli.js fix --report --json >> experiments/editing-ceiling/results/probe1-report.json 2>&1
say "DONE — report in experiments/editing-ceiling/results/probe1-report.json"
say "free disk now: $(df -h . | awk 'NR==2 {print $4}')"
