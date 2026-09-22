"""Phase 14c's result — Reach, S_big, S_small, and the fork the frozen rule names.

    python3 scripts/results-14c.py <run_dir> <plan.json> [--out experiments/reach/results/result-14c-<date>.json]

Written on 22 Sep 2026 **before the run started**, like the rule it applies. Nothing here chooses:

  * a task **survives** iff any of its attempts' verdicts says `survived` (the first attempt or the one
    mechanical retry; correction is off). A task with no verdict, because it threw, a refusal, or an
    unparsed answer all count in the denominator as not surviving;
  * `S_big` = survivors among `big-*`, `S_small` = survivors among `small-*`, each `k/n` with an exact
    Clopper–Pearson 95 % interval, `results-11b.py`'s function, not a second implementation;
  * `Reach` is read from the committed after-census, never recomputed here;
  * the fork is `phase-14c-the-reach.md` §3, applied to the point estimates as written, **and** the
    report says whether the two intervals overlap, because at these sizes they will, and a ratio
    between overlapping intervals is a direction rather than a result (§3).

Counts, never names (CLAUDE.md #7): the payload carries task ids (`big-01`), rules and counts, never a
path or the run id, which is built from the project directory's name.
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

run_dir = Path(sys.argv[1])
plan_path = Path(sys.argv[2])
out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else \
    f"experiments/reach/results/result-14c-{datetime.now().strftime('%Y-%m-%d')}.json"
census = json.load(open(sorted(Path("experiments/reach/results").glob("census-after-project-a-*.json"))[-1]))

plan = json.load(open(plan_path))
tasks = [t["task_id"] for s in plan["steps"] for t in s["tasks"]]

verdicts: dict[str, list[dict]] = {}
for f in sorted((run_dir / "verdicts").glob("*.json")):
    v = json.load(open(f))
    verdicts.setdefault(v["task_id"].split("#")[0], []).append(v)


def outcome(tid: str) -> dict:
    vs = verdicts.get(tid, [])
    if not vs:
        return {"survived": False, "stage": "threw", "confinement": [], "attempts": 0}
    last = vs[-1]
    return {
        "survived": any(v["survived"] for v in vs),
        "stage": "done" if any(v["survived"] for v in vs) else last.get("stage_reached"),
        "confinement": sorted({b["rule"] for v in vs for b in v.get("confinement", [])}),
        "refused": any(v.get("refused") for v in vs),
        "attempts": len(vs),
        "flags": sorted({f for v in vs for f in v.get("compiler_flags", [])}),
        "retried_regressions": any((v.get("tests") or {}).get("first_reading") for v in vs),
        "demoted": sum(1 for v in vs for o in v.get("observations", []) if o.get("kind") == "test_type_error_demoted"),
    }


rows = {tid: outcome(tid) for tid in tasks}
arm = lambda p: [t for t in tasks if t.startswith(p)]
big, small = arm("big-"), arm("small-")
s_big = rate(sum(rows[t]["survived"] for t in big), len(big))
s_small = rate(sum(rows[t]["survived"] for t in small), len(small))
reach = census["source_files"]["reach"]

if reach < 0.85:
    fork = "STOP — re-open ADR-0075"
elif s_small["rate"] and s_big["rate"] >= 0.75 * s_small["rate"]:
    fork = "PROCEED to 14d"
elif not s_small["rate"]:
    fork = "UNDEFINED — S_small is 0, so 0.75 × S_small is 0 and the ratio says nothing; reported, not decided"
else:
    fork = "INSERT 14c′ — a big change is not a big file"
overlap = not (s_big["ci95"][1] < s_small["ci95"][0] or s_small["ci95"][1] < s_big["ci95"][0])

funnel = lambda ts: dict(Counter(rows[t]["stage"] for t in ts))
payload = {
    "measured": True,
    "kind": "phase-14c-result",
    "computed_at": datetime.now(timezone.utc).isoformat(),
    "rule": "docs/plan/prompts/phase-14c-the-reach.md §3 (frozen 22 Sep 2026)",
    "reach": round(reach, 4),
    "reach_before": round(census["source_files"]["reach_whole_file"], 4),
    "S_big": s_big,
    "S_small": s_small,
    "threshold": {"0.75_x_S_small": round(0.75 * (s_small["rate"] or 0), 3)},
    "intervals_overlap": overlap,
    "fork": fork,
    "fork_caveat": "the intervals overlap, so the fork is a direction rather than a result (§3)" if overlap else None,
    "gate": {
        "retry_regressions": plan.get("retry_regressions"),
        "demote_test_type_errors": plan.get("demote_test_type_errors"),
        "compiler_flags": plan.get("compiler_flags"),
        "correction": plan["correction"]["enabled"],
        "adr_0086_s6": "A",
        "verdict_flags_seen": sorted({f for r in rows.values() for f in r.get("flags", [])}),
    },
    "funnel": {"big": funnel(big), "small": funnel(small)},
    "confinement": {
        "big": dict(Counter(c for t in big for c in rows[t]["confinement"])),
        "small": dict(Counter(c for t in small for c in rows[t]["confinement"])),
    },
    "refusals": {"big": sum(rows[t].get("refused", False) for t in big), "small": sum(rows[t].get("refused", False) for t in small)},
    "regression_retries_used": sum(r.get("retried_regressions", False) for r in rows.values()),
    "test_type_errors_demoted": sum(r.get("demoted", 0) for r in rows.values()),
    "per_task": {t: {k: v for k, v in rows[t].items() if k != "flags"} for t in tasks},
}
Path(out).parent.mkdir(parents=True, exist_ok=True)
Path(out).write_text(json.dumps(payload, indent=2) + "\n")
print(json.dumps({k: payload[k] for k in ("reach", "S_big", "S_small", "intervals_overlap", "fork")}, indent=2))
print(f"wrote {out}")
