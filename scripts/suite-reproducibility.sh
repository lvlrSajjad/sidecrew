#!/bin/bash
# Is the project's own suite deterministic? — the floor under ADR-0066's D.
#
#   caffeinate -i scripts/suite-reproducibility.sh
#
# **No worker and no model.** Nothing is generated and no change is applied: this runs the unmodified
# project's suite n times in fresh clones and counts which tests flip. Probe 1's baseline suite took
# 260 s, so 20 runs is roughly 100 minutes plus the clones.
#
# The plan is gitignored and lives on one machine (CLAUDE.md #7), so its path comes from the
# environment or is defaulted locally and never written into a tracked file. Only the plan's `project`
# field is read from it.
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"   # ADR-0049: the project's suite needs its own node
export NODE_OPTIONS=--max-old-space-size=8192               # ADR-0032

cd "$(dirname "$0")/.." || exit 1
PLAN="${PLAN:-experiments/correction-round/plans/project-a-2026-09-20/change_plan.json}"
RUNS="${RUNS:-20}"
LOG=experiments/gate-error-rate/results/suite-reproducibility.log

mkdir -p experiments/gate-error-rate/results
: > "$LOG"
say () { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

TMP="${TMPDIR:-/tmp}"; TMP="${TMP%/}"
sweep () {
  local n
  n=$(ls -d "$TMP"/sidecrew-fix-* "$TMP"/sidecrew-task-* "$TMP"/sidecrew-nm-* 2>/dev/null | wc -l | tr -d ' ')
  [ "${n:-0}" -gt 0 ] && echo "sweeping $n leftover sandbox(es)" | tee -a "$LOG"
  rm -rf "$TMP"/sidecrew-fix-* "$TMP"/sidecrew-task-* "$TMP"/sidecrew-nm-* 2>/dev/null
  return 0
}
trap 'sweep; say "sandboxes swept — machine left as found"' EXIT INT TERM
sweep

[ -f "$PLAN" ] || { say "ABORT — no plan at $PLAN. It is gitignored and exists on one machine."; exit 1; }

FREE_GB=$(df -g . | awk 'NR==2 {print $4}')
if [ "${FREE_GB:-0}" -lt 20 ]; then say "ABORT — ${FREE_GB} GB free; the clones need room"; exit 1; fi

if [ -n "$(git status --porcelain)" ]; then
  say "ABORT — the tree is dirty. A tsx harness imports ../src/*.js from SOURCE, so uncommitted edits"
  say "        compile into the run with nothing in any log to show it."
  exit 1
fi
say "commit $(git rev-parse HEAD)"
say "local time now $(date '+%H:%M'); ~${RUNS} runs at roughly 5 min each"

say "── the floor under D: ${RUNS} runs of the unmodified suite ──"
npx tsx scripts/suite-reproducibility.ts "$PLAN" --runs "$RUNS" 2>&1 | tee -a "$LOG"
say "harness exited ${PIPESTATUS[0]}"
say "free disk now: $(df -h . | awk 'NR==2 {print $4}')"
