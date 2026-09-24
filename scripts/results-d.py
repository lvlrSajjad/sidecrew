"""ADR-0082 D's result — Y per arm and pooled, the cost per pinned region, and the frozen fork.

    python3 scripts/results-d.py [--out FILE]

Written 24 Sep 2026 **before D's run**, applying `docs/plan/prompts/adr-0082-d.md` §2–§3 and its §1
amendments. Nothing here chooses:

  * a declaration **survives** iff its function's task is among the survivors of its module's run;
  * the **denominator is all 20** declarations. The four unplannable ones, and any module whose exemplar
    did not verify, count as not surviving. That is the pooled `Y` the fork is applied to. `Y` over the
    16 plannable declarations is reported beside it and decides nothing;
  * `k/n` with `results-11b.py`'s exact interval; the fork is §3, on pooled `Y`.

Counts, task ids and module numbers only — never a path or an identifier from the client (CLAUDE.md #7).
"""
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location("r11b", Path(__file__).with_name("results-11b.py"))
r11b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r11b)
rate = r11b.rate

out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else \
    f"experiments/test-first/results/result-d-{datetime.now().strftime('%Y-%m-%d')}.json"
res = Path("experiments/test-first/results")
plans = Path("experiments/test-first/plans")
pop = json.load(open("experiments/test-first/local/d-population.json"))
UNPLANNABLE = {"small-01", "small-03", "small-04", "small-09"}  # §1 amendment, 03:30

module_dir = {}
for d in sorted(plans.glob("m*")):
    c = d / "choice.json"
    if c.exists():
        module_dir[json.load(open(c))["module"]] = d.name

rows, scores, wall = [], [], 0
for d in (res / "d-wall.txt").read_text().split("\n") if (res / "d-wall.txt").exists() else []:
    if d.strip():
        wall += int(d.split()[1])
for r in pop["rows"]:
    m = module_dir.get(r["module"])
    verified = m is not None and json.load(open(res / f"{m}-validate.json")).get("valid") is True \
        if m is not None and (res / f"{m}-validate.json").exists() else False
    run_path = res / f"{m}-run.json" if m else None
    survived, score = False, None
    if run_path is not None and run_path.exists():
        run = json.load(open(run_path))
        for s in run.get("survivors", []):
            if s["task_id"].split(":")[0] == r["function_name"]:
                survived, score = True, s.get("mutation_score")
    if score is not None:
        scores.append(score)
    rows.append({"task_id": r["task_id"], "arm": r["arm"], "module": m, "unplannable": r["task_id"] in UNPLANNABLE,
                 "exemplar_verified": verified, "survived": survived, "mutation_score": score})

def arm(a=None):
    rs = [x for x in rows if a is None or x["arm"] == a]
    return rate(sum(x["survived"] for x in rs), len(rs))

pooled = arm()
plannable = [x for x in rows if not x["unplannable"]]
y = pooled["rate"] or 0.0
if y >= 0.50:
    fork = "BUILD ADR-0082 B — test-first pinning as the default for #2a"
elif y >= 0.25:
    fork = "BUILD B, SCOPED — pin only regions the project's own suite does not cover"
else:
    fork = "B NOT AFFORDABLE AS IT STANDS — principle stays; next, measure what raises Y"
big, small = arm("big"), arm("small")
survivors = sum(x["survived"] for x in rows)
payload = {
    "measured": True, "kind": "adr-0082-d-result", "computed_at": datetime.now(timezone.utc).isoformat(),
    "rule": "docs/plan/prompts/adr-0082-d.md §2–§3 (frozen 24 Sep 2026) and its §1 amendments",
    "Y_pooled": pooled, "Y_big": big, "Y_small": small,
    "Y_plannable_only": rate(sum(x["survived"] for x in plannable), len(plannable)),
    "fork": fork,
    "big_wholly_below_small": big["ci95"][1] < small["ci95"][0],
    "denominator_note": "all 20 declarations; unplannable and unverified-exemplar modules count as not surviving",
    "exemplars": {"planned_modules": len(module_dir),
                  "verified": sum(1 for m in set(x["module"] for x in rows if x["module"]) if (res / f"{m}-validate.json").exists()
                                  and json.load(open(res / f"{m}-validate.json")).get("valid") is True)},
    "cost": {"run_wall_s": wall, "survivors": survivors,
             "wall_s_per_pinned_region": round(wall / survivors, 1) if survivors else None},
    "survivor_mutation_scores": scores,
    "per_declaration": rows,
}
Path(out).write_text(json.dumps(payload, indent=2) + "\n")
print(json.dumps({k: payload[k] for k in ("Y_pooled", "Y_big", "Y_small", "Y_plannable_only", "fork", "cost")}, indent=2))
print(f"wrote {out}")
