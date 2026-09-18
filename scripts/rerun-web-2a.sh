#!/bin/bash
# The two project-b arms, re-run after ADR-0053. project-a's arms are unaffected and are kept: the fix
# only ever *removes* entries from `regressed`, and project-a reported none.
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
export NODE_OPTIONS=--max-old-space-size=8192
cd <path> || exit 1
LOG=experiments/go-no-go-2a/results/overnight.log
say () { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
TMP="${TMPDIR:-/tmp}"; TMP="${TMP%/}"
sweep () { rm -rf "$TMP"/sidecrew-fix-* "$TMP"/sidecrew-task-* "$TMP"/sidecrew-nm-* 2>/dev/null; return 0; }
finish () { sweep; node dist/cli.js stop >/dev/null 2>&1; say "worker stopped, sandboxes swept"; }
trap finish EXIT INT TERM
sweep

if ! node dist/cli.js status --json | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['worker']['up'] else 1)"; then
  say "starting worker"
  nohup node dist/cli.js serve > experiments/go-no-go-2a/results/serve.log 2>&1 &
  for _ in $(seq 1 60); do sleep 5; node dist/cli.js status --json | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['worker']['up'] else 1)" && break; done
fi
node dist/cli.js status --json | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['worker']['up'] else 1)" || { say "ABORT — no worker"; exit 1; }

arm () {
  local config="$1" try
  for try in 1 2; do
    say "── $config/web, attempt $try (post ADR-0053) ──"
    perl -e 'alarm shift; exec @ARGV' 5400 npx tsx scripts/go-no-go-2a.ts --config "$config" --input web >> "$LOG" 2>&1
    if python3 scripts/check-baseline-2a.py "$config" web 2>&1 | tee -a "$LOG" | grep -q '^OK'; then
      say "$config/web ACCEPTED"; return 0
    fi
    say "$config/web discarded"
  done
  say "$config/web FAILED after two attempts"; return 1
}

arm c2
arm c3

say "── coverage web ──"
globs=$(python3 -c "
import json
p=json.load(open('experiments/go-no-go-2a/plans/project-b.json'))
print(' '.join(f\"--collectCoverageFrom={t['files'][0]}\" for s in p['steps'] for t in s['tasks']))")
( cd <project>/project-b && ./node_modules/.bin/jest --ci --coverage --coverageReporters=json \
    --coverageDirectory=<path> $globs ) >> "$LOG" 2>&1
say "coverage web exit=$?"

say "── coverage api ──"
globs=$(python3 -c "
import json
p=json.load(open('experiments/go-no-go-2a/plans/project-a.json'))
print(' '.join(f\"--collectCoverageFrom={t['files'][0]}\" for s in p['steps'] for t in s['tasks']))")
( cd <project>/project-a && ./node_modules/.bin/jest --ci --coverage --coverageReporters=json \
    --coverageDirectory=<path> $globs ) >> "$LOG" 2>&1
say "coverage api exit=$?"

say "WEB-DONE"
