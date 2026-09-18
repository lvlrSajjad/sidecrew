#!/bin/bash
# The Phase 11 matrix, unattended. Everything C3 needs from the agent is already on disk
# (experiments/go-no-go-2a/c3/<input>/answers/), so this runs without anybody in the loop.
#
#   caffeinate -i scripts/overnight-2a.sh
#
# Each arm is run, then its baseline is checked against the quiet-machine reference. A mismatch means
# the machine moved under the measurement, so the arm is discarded and retried once; a second mismatch
# leaves a FAILED line for a human. Nothing is repaired or adjusted — see the protocol note in
# experiments/go-no-go-2a/README.md.
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
export NODE_OPTIONS=--max-old-space-size=8192
cd <path> || exit 1

LOG=experiments/go-no-go-2a/results/overnight.log
: > "$LOG"
say () { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

# ── leaving the machine as we found it ───────────────────────────────────────────────────────────
#
# `runFix` deletes its own sandboxes, and `verifyChange` deletes each per-task clone; none of that
# runs if this script is killed. A sandbox of project-a is ~500 MB and there is one per task, so an
# interrupted overnight run is the one way this fills a disk. Swept at entry and on every exit path,
# including Ctrl-C.
# macOS sets TMPDIR with a trailing slash and Linux usually does not, so it is normalised once here
# rather than concatenated at four call sites — `/tmp` + `sidecrew-fix-*` is `/tmpsidecrew-fix-*`,
# which matches nothing and would have swept nothing while looking like it worked.
TMP="${TMPDIR:-/tmp}"
TMP="${TMP%/}"
sweep () {
  local n
  n=$(ls -d "$TMP"/sidecrew-fix-* "$TMP"/sidecrew-task-* "$TMP"/sidecrew-nm-* 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] && echo "sweeping $n leftover sandbox(es) from $TMP"
  rm -rf "$TMP"/sidecrew-fix-* "$TMP"/sidecrew-task-* "$TMP"/sidecrew-nm-* 2>/dev/null
  return 0
}
finish () {
  sweep
  # The 7B holds ~4.4 GB. Nothing else needs it once the arms are done, and a worker still resident in
  # the morning is 4.4 GB the machine's owner did not ask to donate.
  node dist/cli.js stop >/dev/null 2>&1
  say "worker stopped, sandboxes swept — machine left as found"
}
trap finish EXIT INT TERM
sweep

# A run that cannot finish should not start. Each project-a sandbox is ~0.5 GB and they are created
# and deleted one at a time, but a disk that is already full turns every arm into a setup error.
FREE_GB=$(df -g . | awk 'NR==2 {print $4}')
if [ "${FREE_GB:-0}" -lt 20 ]; then
  echo "ABORT — ${FREE_GB} GB free on this volume; the sandboxes need room to breathe"
  exit 1
fi

arm () {                       # arm <config> <input>
  local config="$1" input="$2" try
  for try in 1 2; do
    say "── $config/$input, attempt $try ──"
    # 90 minutes an arm: 12 tasks at ~5 minutes of gate each is ~60, and the stage timeouts inside
    # `runFix` (300 s compile, 900 s tests) already bound each step. This catches the case they cannot
    # — a worker that answers slowly forever — so one wedged arm costs 90 minutes and not the night.
    perl -e 'alarm shift; exec @ARGV' 5400 \
      npx tsx scripts/go-no-go-2a.ts --config "$config" --input "$input" >> "$LOG" 2>&1
    [ $? -eq 142 ] && say "$config/$input hit the 90-minute ceiling"
    if python3 scripts/check-baseline-2a.py "$config" "$input" 2>&1 | tee -a "$LOG" | grep -q '^OK'; then
      say "$config/$input ACCEPTED"
      return 0
    fi
    say "$config/$input discarded (baseline did not match the reference)"
  done
  say "$config/$input FAILED after two attempts — needs a quiet machine"
  return 1
}

# Coverage for §5's reported hole: the fraction of survivors whose changed lines no test executed.
# Scoped with --collectCoverageFrom to the plan's own files, so the instrumentation cost is paid only
# where the answer is needed. Run once per project, on the unmodified project.
coverage () {                  # coverage <input> <project-dir>
  local input="$1" dir="$2"
  say "── coverage $input ──"
  local globs
  globs=$(python3 -c "
import json
# api -> project-a, web -> project-b: the plans are named for the anonymised projects (CLAUDE.md #7).
p=json.load(open({'api':'experiments/go-no-go-2a/plans/project-a.json','web':'experiments/go-no-go-2a/plans/project-b.json'}['$input']))
print(' '.join(f\"--collectCoverageFrom={t['files'][0]}\" for s in p['steps'] for t in s['tasks']))
")
  ( cd "$dir" && ./node_modules/.bin/jest --ci --coverage --coverageReporters=json \
      --coverageDirectory="<path>" \
      $globs ) >> "$LOG" 2>&1
  say "coverage $input exit=$?"
}

say "START — the machine must be quiet; C2 needs a worker, C3 does not"
node dist/cli.js status --json | tee -a "$LOG"

# C2 is the whole point of the run, so a missing worker is worth one attempt to fix rather than four
# hours of escalations. C3 needs no worker: its answers are already on disk.
if ! node dist/cli.js status --json | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['worker']['up'] else 1)"; then
  say "no worker on :8000 — starting one"
  nohup node dist/cli.js serve > experiments/go-no-go-2a/results/serve.log 2>&1 &
  for _ in $(seq 1 60); do
    sleep 5
    node dist/cli.js status --json | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['worker']['up'] else 1)" && break
  done
fi
if ! node dist/cli.js status --json | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['worker']['up'] else 1)"; then
  say "ABORT — no worker came up, so C2 would record 12 escalations that say nothing about the model"
  exit 1
fi
say "worker is up"

arm c2 api
arm c3 api
arm c2 web
arm c3 web

coverage api <project>/project-a
coverage web <project>/project-b

say "DONE"
say "free disk now: $(df -h . | awk 'NR==2 {print $4}')"
grep -E 'ACCEPTED|FAILED|discarded' "$LOG" | tail -20
