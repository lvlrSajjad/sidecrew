#!/bin/bash
# Phase 14b probe 2 — the 7B on the DECOMPOSED form of §2.2's 30 declared `null_guard` tasks, unattended.
#
#   caffeinate -i scripts/editing-ceiling-probe2.sh
#
# Exactly one thing differs from the pass-1 run this is compared against: the `ask` names the
# enclosing function and its line range instead of the whole file. Same 30 tasks, same files, same
# worker (the 7B), same gate, same `correction.enabled: false`, same concurrency. Probe 1 varies the
# model; this varies reasoning scope; neither varies both.
#
# Build the decomposed plan first, which is what `scripts/editing-ceiling-decompose.ts` emits:
#   npx tsx scripts/editing-ceiling-decompose.ts <plan> <pass1-run-dir> <decomposed-plan>
#
# Both plans are gitignored and live on one machine (CLAUDE.md #7), so the path is taken from the
# environment or defaulted locally and never written into a tracked file.
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"   # ADR-0049: the project's suite needs its own node
export NODE_OPTIONS=--max-old-space-size=8192               # ADR-0032: tsc on the large project

cd "$(dirname "$0")/.." || exit 1
PLAN="${PLAN:-experiments/editing-ceiling/plans/project-a-decomposed.json}"
LOG=experiments/editing-ceiling/results/probe2.log
MODEL=qwen2.5-coder-7b-4bit

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
[ -f "$PLAN" ] || { say "ABORT — no decomposed plan at $PLAN. Build it with scripts/editing-ceiling-decompose.ts from the ORIGINAL 30-task plan (README §2)."; exit 1; }
N=$(python3 -c "import json;print(sum(len(s['tasks']) for s in json.load(open('$PLAN'))['steps']))" 2>/dev/null)
[ "${N:-0}" = 30 ] || { say "ABORT — the decomposed plan has ${N:-?} tasks, not 30. Comparability with the 1/30 baseline needs all thirty (README §2)."; exit 1; }

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
say "starting $MODEL (4.5 GB; --wait queues for free RAM rather than refusing)"
nohup node dist/cli.js serve --model "$MODEL" --wait 3600 >> experiments/editing-ceiling/results/serve-probe2.log 2>&1 &

for _ in $(seq 1 240); do
  sleep 15
  node dist/cli.js status --json 2>/dev/null \
    | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['worker']['up'] else 1)" 2>/dev/null && break
done
if ! node dist/cli.js status --json 2>/dev/null \
     | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['worker']['up'] else 1)" 2>/dev/null; then
  say "ABORT — no worker came up in an hour. The 7B needs 6.5 GB free (4.5 + headroom), which is a"
  say "        much lower bar than probe 1's; if this failed, something other than memory is wrong."
  exit 1
fi
node dist/cli.js status --json | tee -a "$LOG"
say "worker is up — confirm the model line above says 7B: probe 2 must NOT be run on the 14B,\n            or it varies two things at once and measures neither"

# ── the run ──────────────────────────────────────────────────────────────────────────────────────
say "── probe 1: 30 tasks, concurrency 1, correction off ──"
node dist/cli.js fix "$PLAN" --concurrency 1 >> "$LOG" 2>&1
say "fix exited $?"

node dist/cli.js fix --report --json >> experiments/editing-ceiling/results/probe2-report.json 2>&1
say "DONE — report in experiments/editing-ceiling/results/probe2-report.json"
say "free disk now: $(df -h . | awk 'NR==2 {print $4}')"
