#!/bin/bash
# Phase 14d's gated night — the four plans of `docs/plan/prompts/phase-14d-retrieval.md` §1, unattended.
#
#   caffeinate -dims scripts/retrieval-run.sh
#
# The plans are `experiments/planner-cost/plans/project-a-<date>-{base,retr}-{n12,n40}/change_plan.json`,
# written by four planner subagents before this runs. They are gitignored (CLAUDE.md #7): paths come from
# the environment or the defaults and are never written into a tracked file, and so is the log, because
# a run directory's name carries the project's.
#
# **It waits for 02:05 local before it starts** (ADR-0083: project-a moves tests at 00:00 UTC). It runs the
# four plans one after another on two 7B workers, each plan its own `fix` run with its own baseline, and
# records which run directory answered which plan so `scripts/results-14d.py` never has to guess.
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"   # ADR-0049: the project's suite needs its own node
export NODE_OPTIONS=--max-old-space-size=8192               # ADR-0032: tsc on the large project
export SIDECREW_PORTS=8000,8001                             # the 7B at 2 (prompt §1)

cd "$(dirname "$0")/.." || exit 1
DATE="${DATE:-2026-09-25}"
PLANS_DIR=experiments/planner-cost/plans
ORDER="${ORDER:-base-n12 retr-n12 base-n40 retr-n40}"
LOG=$PLANS_DIR/run-14d-$DATE.log
MAP=$PLANS_DIR/run-14d-$DATE-dirs.json
WATCH="${WATCH:-}"                                           # the owner's working checkout: read, fingerprinted
MODEL=qwen2.5-coder-7b-4bit
START_AFTER="${START_AFTER:-02:05}"

: > "$LOG"
say () { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

TMP="${TMPDIR:-/tmp}"; TMP="${TMP%/}"
sweep () {
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
for arm in $ORDER; do
  p=$PLANS_DIR/project-a-$DATE-$arm/change_plan.json
  [ -f "$p" ] || { say "ABORT — no plan at $p; the planners have not finished, or one failed"; exit 1; }
  shasum -a 256 "$p" | sed "s#  .*# $arm#" >> "$LOG"
done
if [ -n "$(git status --porcelain)" ]; then
  say "ABORT — the tree is dirty; a harness compiles uncommitted edits into the run invisibly"; exit 1
fi
PROJECT=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['project'])" "$PLANS_DIR/project-a-$DATE-base-n12/change_plan.json")
for arm in $ORDER; do
  q=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['project'])" "$PLANS_DIR/project-a-$DATE-$arm/change_plan.json")
  [ "$q" = "$PROJECT" ] || { say "ABORT — the four plans do not name one project (§1: one project, one commit)"; exit 1; }
done
if [ -n "$(git -C "$PROJECT" status --porcelain)" ]; then say "ABORT — the clone's tree is dirty"; exit 1; fi
say "sidecrew $(git rev-parse HEAD) · project $(git -C "$PROJECT" rev-parse HEAD)"

fingerprint () {
  ( cd "$1" && git rev-parse HEAD; git status --porcelain --untracked-files=all | shasum -a 256
    for f in package.json package-lock.json yarn.lock pnpm-lock.yaml; do [ -f "$f" ] && shasum -a 256 "$f"; done
    ls -A node_modules | shasum -a 256; ls -A node_modules/.bin | shasum -a 256 ) 2>/dev/null
}

# ── wait for the boundary to pass ────────────────────────────────────────────────────────────────
now=$(date +%s)
target=$(date -j -f "%Y-%m-%d %H:%M" "$(date +%Y-%m-%d) $START_AFTER" +%s)
if [ "$target" -gt "$now" ] && [ $((target - now)) -lt $((20 * 3600)) ]; then
  say "waiting until $START_AFTER local so the run does not span 00:00 UTC (ADR-0083)"
  sleep $((target - now))
fi
say "starting at $(date '+%H:%M') local, $(date -u '+%H:%M') UTC"
if [ -n "$(git -C "$PROJECT" status --porcelain)" ]; then say "ABORT — the clone went dirty while waiting"; exit 1; fi

FREE_GB=$(df -g . | awk 'NR==2 {print $4}')
if [ "${FREE_GB:-0}" -lt 20 ]; then say "ABORT — ${FREE_GB} GB free; the sandboxes need room"; exit 1; fi
sweep
[ -n "$WATCH" ] && fingerprint "$WATCH" > "$PLANS_DIR/watch-before-14d.txt" && say "working checkout fingerprinted (it is only read)"
fingerprint "$PROJECT" > "$PLANS_DIR/clone-before-14d.txt"

# ── the workers ──────────────────────────────────────────────────────────────────────────────────
node dist/cli.js stop --port 8000 >/dev/null 2>&1
node dist/cli.js stop --port 8001 >/dev/null 2>&1
for port in 8000 8001; do
  say "starting $MODEL on :$port"
  nohup node dist/cli.js serve --model "$MODEL" --port "$port" --wait 3600 >> "$PLANS_DIR/serve-14d-$port.log" 2>&1 &
done
up () { node dist/cli.js status --port "$1" --json 2>/dev/null | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['worker']['up'] else 1)" 2>/dev/null; }
for _ in $(seq 1 240); do sleep 15; up 8000 && up 8001 && break; done
if ! up 8000 || ! up 8001; then say "ABORT — both workers did not come up within an hour"; exit 1; fi
say "both workers up"

# ── the four runs ────────────────────────────────────────────────────────────────────────────────
echo "{" > "$MAP"
first=1
for arm in $ORDER; do
  p=$PLANS_DIR/project-a-$DATE-$arm/change_plan.json
  before=$(ls -1 .sidecrew/runs 2>/dev/null | sort | tail -1)
  say "── $arm: concurrency 2, correction off, gate at its defaults ──"
  node dist/cli.js fix "$p" --concurrency 2 >> "$LOG" 2>&1
  say "$arm: fix exited $?"
  after=$(ls -1 .sidecrew/runs 2>/dev/null | sort | tail -1)
  if [ "$after" = "$before" ]; then say "$arm: no new run directory — recorded as missing"; after=""; fi
  [ $first -eq 1 ] || echo "," >> "$MAP"; first=0
  printf '  "%s": "%s"' "$arm" "$after" >> "$MAP"
  sweep
done
echo "" >> "$MAP"; echo "}" >> "$MAP"

fingerprint "$PROJECT" > "$PLANS_DIR/clone-after-14d.txt"
cmp -s "$PLANS_DIR/clone-before-14d.txt" "$PLANS_DIR/clone-after-14d.txt" \
  && say "clone: IDENTICAL before and after (ADR-0088)" || say "clone: CHANGED during the run — ADR-0088 breach; see clone-*.txt"
if [ -n "$WATCH" ]; then
  fingerprint "$WATCH" > "$PLANS_DIR/watch-after-14d.txt"
  cmp -s "$PLANS_DIR/watch-before-14d.txt" "$PLANS_DIR/watch-after-14d.txt" \
    && say "working checkout: IDENTICAL before and after" || say "working checkout: CHANGED during the run — see watch-*.txt"
fi
say "DONE — run directories in $MAP; next: python3 scripts/results-14d.py"
