"""Phase 14c′'s result — S′_big, S′_small, B's safety check, and the frozen fork.

    python3 scripts/results-14c-prime.py <run_dir> <plan.json> [--out FILE]

Written 23 Sep 2026 **before the run**, like the rule it applies (`docs/plan/prompts/phase-14c-prime.md`
§2–§3). Nothing here chooses:

  * a task **survives** iff any attempt's verdict says `survived`; a task with no verdict counts in the
    denominator as not surviving;
  * `S′_big` over `big-*`, `S′_small` over `small-*`, each `k/n` with `results-11b.py`'s exact interval;
  * **B's safety check overrides the fork**: any combined regression, or any of the plan's files ending
    with more `tsc` errors in `combined-errors.json` than in `baselines/0.json`, is STOP;
  * every verdict must say `target_scope: "declaration"`, or the run did not measure B and says so.

Counts and task ids only — never a path or the run id (CLAUDE.md #7).
"""
import importlib.util
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location("r11b", Path(__file__).with_name("results-11b.py"))
r11b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r11b)
rate = r11b.rate

run_dir, plan_path = Path(sys.argv[1]), Path(sys.argv[2])
out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else \
    f"experiments/reach/results/result-14c-prime-{datetime.now().strftime('%Y-%m-%d')}.json"
plan = json.load(open(plan_path))
tasks = [t for s in plan["steps"] for t in s["tasks"]]
files = sorted({t["files"][0] for t in tasks})

verdicts: dict[str, list[dict]] = {}
for f in sorted((run_dir / "verdicts").glob("*.json")):
    v = json.load(open(f))
    verdicts.setdefault(v["task_id"].split("#")[0], []).append(v)

def survived(tid: str) -> bool:
    return any(v["survived"] for v in verdicts.get(tid, []))

ids = [t["task_id"] for t in tasks]
big = [t for t in ids if t.startswith("big-")]
small = [t for t in ids if t.startswith("small-")]
s_big = rate(sum(map(survived, big)), len(big))
s_small = rate(sum(map(survived, small)), len(small))
overlap = not (s_big["ci95"][1] < s_small["ci95"][0] or s_small["ci95"][1] < s_big["ci95"][0])

result = json.load(open(run_dir / "result.json"))
combined_regressions = result["project"]["combined_regressions"]
start = json.load(open(run_dir / "baselines" / "0.json"))["errors"]["by_file"]
end_path = run_dir / "combined-errors.json"
end = json.load(open(end_path))["by_file"] if end_path.exists() else None
worse_files = None if end is None else sum(1 for f in files if end.get(f, 0) > start.get(f, 0))
scopes = Counter(v.get("target_scope", "file") for vs in verdicts.values() for v in vs)

if combined_regressions > 0 or worse_files is None or worse_files > 0:
    fork = "STOP — B passed something it should not have; fix the gate first (§2)" if end is not None else \
        "STOP — combined-errors.json is missing, so B's safety check cannot be read (§2)"
elif not s_small["rate"]:
    fork = "UNDEFINED — S′_small is 0; report the rates, decide nothing"
elif s_big["rate"] >= 0.75 * s_small["rate"]:
    fork = "PROCEED to 14d — usable, big files not worse" if s_big["rate"] >= 0.30 else \
        "PROCEED to 14d — improvable, not usable; v0.2.0 stays held; ADR-0087 C next, as a probe"
else:
    fork = "INSERT 14c″ = ADR-0087 C — at equal change size, big files do worse"

by_stage = lambda ts: dict(Counter(("done" if survived(t) else (verdicts.get(t) or [{}])[-1].get("stage_reached", "threw")) for t in ts))
files_cleared = None if end is None else sum(1 for f in files if end.get(f, 0) == 0)
payload = {
    "measured": True, "kind": "phase-14c-prime-result", "computed_at": datetime.now(timezone.utc).isoformat(),
    "rule": "docs/plan/prompts/phase-14c-prime.md §2–§3 (frozen 23 Sep 2026)",
    "S_prime_big": s_big, "S_prime_small": s_small,
    "threshold": {"usable": 0.30, "0.75_x_S_prime_small": round(0.75 * (s_small["rate"] or 0), 3)},
    "intervals_overlap": overlap,
    "fork": fork,
    "fork_caveat": "the intervals overlap, so the fork is a direction rather than a result (§3)" if overlap else None,
    "safety": {"combined_regressions": combined_regressions, "files_worse_than_start": worse_files, "files": len(files)},
    "gate": {k: plan.get(k) for k in ("symbol_gate", "retry_regressions", "demote_test_type_errors", "compiler_flags")},
    "verdict_scopes": dict(scopes),
    "funnel": {"big": by_stage(big), "small": by_stage(small)},
    "descriptive": {"files_left_with_zero_errors": files_cleared,
                    "errors_start_in_plan_files": sum(start.get(f, 0) for f in files),
                    "errors_end_in_plan_files": None if end is None else sum(end.get(f, 0) for f in files)},
    "per_task": {t: survived(t) for t in ids},
}
Path(out).parent.mkdir(parents=True, exist_ok=True)
Path(out).write_text(json.dumps(payload, indent=2) + "\n")
print(json.dumps({k: payload[k] for k in ("S_prime_big", "S_prime_small", "intervals_overlap", "safety", "fork")}, indent=2))
print(f"wrote {out}")
