#!/bin/bash
# ADR-0077 option D — the counterfactual, run with the conditions probe 1 ran under.
#
#   caffeinate -i scripts/adr-0077-counterfactual.sh
#
# **No worker and no model.** This replays the verify stage over candidates already on disk, so there
# is nothing to generate and no 8.2 GB resident. What it costs is the suite: probe 1's baseline took
# 260 s, so 15 tasks that reach it are roughly 70–80 minutes plus one baseline.
#
# The run directory and the plan are gitignored and live on one machine (CLAUDE.md #7), so both come
# from the environment or are defaulted locally, and neither is written into a tracked file.
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"   # ADR-0049: the project's suite needs its own node
export NODE_OPTIONS=--max-old-space-size=8192               # ADR-0032: tsc on the large project

cd "$(dirname "$0")/.." || exit 1
PLAN="${PLAN:-experiments/correction-round/plans/project-a-2026-09-20/change_plan.json}"
RUN_DIR="${RUN_DIR:-}"
LOG=experiments/editing-ceiling/results/adr-0077-counterfactual.log

mkdir -p experiments/editing-ceiling/results
: > "$LOG"
say () { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

# ── leaving the machine as we found it ───────────────────────────────────────────────────────────
# The harness removes each per-task clone in a `finally` and the shared sandbox at the end; none of
# that runs if this is killed, and a project-a sandbox is ~0.5 GB.
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

# ── a run that cannot finish should not start ────────────────────────────────────────────────────
[ -f "$PLAN" ] || { say "ABORT — the declared plan is not at $PLAN. It is gitignored and exists on one machine; do NOT regenerate it."; exit 1; }

if [ -z "$RUN_DIR" ]; then
  RUN_DIR=$(node -p "require('./experiments/editing-ceiling/results/probe1-report.json').run_dir" 2>/dev/null)
fi
[ -d "$RUN_DIR" ] || { say "ABORT — probe 1's run directory is not on disk. Set RUN_DIR, or check probe1-report.json."; exit 1; }
say "run dir resolved from probe1-report.json (not echoed — the directory name carries the project's name)"

FREE_GB=$(df -g . | awk 'NR==2 {print $4}')
if [ "${FREE_GB:-0}" -lt 20 ]; then say "ABORT — ${FREE_GB} GB free; the sandboxes need room"; exit 1; fi

if [ -n "$(git status --porcelain)" ]; then
  say "ABORT — the tree is dirty. A tsx harness imports ../src/*.js from SOURCE, so uncommitted edits"
  say "        compile into the run with nothing in any log to show it (HANDOFF § Standing hazards)."
  exit 1
fi
say "commit $(git rev-parse HEAD)"

# ADR-0069: the baseline is captured once at the start, and a verdict taken on the next calendar day
# against it can lose the whole run rather than one task. This one DOES reach the suite.
say "local time now $(date '+%H:%M'); expect ~80 min. Crossing midnight would put ADR-0069 in play."

say "── the counterfactual: 15 clean-target tasks, no worker, suite only ──"
npx tsx scripts/adr-0077-counterfactual.ts "$RUN_DIR" "$PLAN" 2>&1 | tee -a "$LOG"
say "harness exited ${PIPESTATUS[0]}"
say "free disk now: $(df -h . | awk 'NR==2 {print $4}')"
