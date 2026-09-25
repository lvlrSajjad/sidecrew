#!/bin/bash
# Phase 14d — re-gate the machine failures, once, quietly (`prompts/phase-14d-retrieval.md`, note of 25 Sep
# ~05:30, written before any re-gate ran).
#
#   caffeinate -dims scripts/retrieval-regate.sh
#
# For every arm, the tasks whose every attempt was a machine failure go into a sub-plan with the same task
# definitions, run at concurrency 1 on one 7B worker. The worker is deterministic (non-negotiable #4), so
# the candidates are the same ones; only the machine under them changes. A real verdict is never re-read.
set -u
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
export NODE_OPTIONS=--max-old-space-size=8192
export SIDECREW_PORTS=8000

cd "$(dirname "$0")/.." || exit 1
DATE="${DATE:-2026-09-25}"
PLANS_DIR=experiments/planner-cost/plans
MAP=$PLANS_DIR/run-14d-$DATE-dirs.json
LOG=$PLANS_DIR/regate-14d-$DATE.log
MODEL=qwen2.5-coder-7b-4bit
: > "$LOG"
say () { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
TMP="${TMPDIR:-/tmp}"; TMP="${TMP%/}"
finish () {
  rm -rf "$TMP"/sidecrew-fix-* "$TMP"/sidecrew-task-* 2>/dev/null
  node dist/cli.js stop --port 8000 >/dev/null 2>&1
  say "worker stopped, sandboxes swept"
}
trap finish EXIT INT TERM

# Build the sub-plans: tasks whose every recorded attempt is a machine failure.
python3 - "$DATE" <<'EOF' | tee -a "$LOG"
import json, re, sys
from pathlib import Path
date = sys.argv[1]
plans = Path("experiments/planner-cost/plans")
dirs = dict(re.findall(r'"([\w-]+)":\s*"([^"]*)"', (plans / f"run-14d-{date}-dirs.json").read_text()))
for arm in ["base-n12", "retr-n12", "base-n40", "retr-n40"]:
    run = dirs.get(arm, "")
    plan = json.load(open(plans / f"project-a-{date}-{arm}" / "change_plan.json"))
    verdicts = {}
    for f in (Path(".sidecrew/runs") / run / "verdicts").glob("*.json"):
        v = json.load(open(f))
        verdicts.setdefault(v["task_id"].split("#")[0], []).append(v)
    failed = {t for t, vs in verdicts.items() if vs and all(v.get("machine_failure") for v in vs)}
    if not failed:
        print(f"{arm}: no machine failures")
        continue
    steps = []
    for s in plan["steps"]:
        tasks = [t for t in s["tasks"] if t["task_id"] in failed]
        if tasks:
            steps.append({**s, "tasks": tasks})
    sub = {**plan, "steps": steps}
    out = plans / f"project-a-{date}-{arm}-regate"
    out.mkdir(exist_ok=True)
    (out / "change_plan.json").write_text(json.dumps(sub, indent=2))
    print(f"{arm}: {len(failed)} machine failure(s) to re-gate")
EOF

[ -z "$(git -C "$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['project'])" "$PLANS_DIR/project-a-$DATE-base-n12/change_plan.json")" status --porcelain)" ] \
  || { say "ABORT — the clone is dirty"; exit 1; }

node dist/cli.js stop --port 8000 >/dev/null 2>&1
nohup node dist/cli.js serve --model "$MODEL" --port 8000 --wait 3600 >> "$PLANS_DIR/serve-regate.log" 2>&1 &
up () { node dist/cli.js status --port 8000 --json 2>/dev/null | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin)['worker']['up'] else 1)" 2>/dev/null; }
for _ in $(seq 1 120); do sleep 15; up && break; done
up || { say "ABORT — the worker did not come up"; exit 1; }

for arm in base-n12 retr-n12 base-n40 retr-n40; do
  p=$PLANS_DIR/project-a-$DATE-$arm-regate/change_plan.json
  [ -f "$p" ] || continue
  before=$(ls -1 .sidecrew/runs | sort | tail -1)
  say "── re-gate $arm at concurrency 1 ──"
  node dist/cli.js fix "$p" --concurrency 1 >> "$LOG" 2>&1
  say "re-gate $arm: fix exited $?"
  after=$(ls -1 .sidecrew/runs | sort | tail -1)
  [ "$after" = "$before" ] && after=""
  python3 - "$MAP" "regate-$arm" "$after" <<'EOF'
import re, sys
path, key, val = sys.argv[1:]
text = open(path).read().rstrip().rstrip("}").rstrip()
open(path, "w").write(f'{text},\n  "{key}": "{val}"\n}}\n')
EOF
  rm -rf "$TMP"/sidecrew-fix-* "$TMP"/sidecrew-task-* 2>/dev/null
done
say "DONE — re-gate runs recorded in $MAP"
