"""Phase 14d's result — R₁, R₀, S₁, S₀, the quality veto and the frozen fork.

    python3 scripts/results-14d.py [--date 2026-09-25] [--out FILE]

Written 25 Sep 2026 **before the gated run**, like the rule it applies
(`docs/plan/prompts/phase-14d-retrieval.md` §2–§3). Nothing here chooses:

  * `N` is the validated plan's task count (the validator's refusals were removed by the planner before
    it reported `valid`, §4.1). `P_total` is the planner transcript's `total_excluding_cache_reads`,
    de-duplicated by message id keeping the last (the 19 Sep amendment). `W_upper` = 7,794.
  * `R` = `P_total / N / 7,794`, at each size and arm. **The fork reads `R₁` at `N ≈ 12` only.**
  * A task **survives** iff any attempt's verdict says `survived`; a task with no verdict counts in the
    denominator as not surviving. `S₀`, `S₁` pooled over both sizes, exact 95 % intervals (`results-11b.py`).
  * **The veto**: `S₁`'s upper bound below `S₀`'s point estimate → STOP for retrieval as built. Either arm's
    pooled `n` below 20 → the veto is INCONCLUSIVE and the fork is applied with that stated.
  * **A base-arm transcript with any retrieval call is void** (the prompt file's note), checked here with
    `planner-decompose.py`'s own counter.

Transcripts are passed by the environment (`T_BASE_N12`, `T_RETR_N12`, `T_BASE_N40`, `T_RETR_N40`), because
their paths are local configuration. Counts and task ids only — never a path or a run id (CLAUDE.md #7).
"""
import importlib.util
import json
import os
import platform
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rate = load("r11b", "results-11b.py").rate
decompose = load("dec", "planner-decompose.py")

W_UPPER = 7794
date = sys.argv[sys.argv.index("--date") + 1] if "--date" in sys.argv else "2026-09-25"
out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else \
    f"experiments/planner-cost/results/result-14d-{date}.json"
plans = Path("experiments/planner-cost/plans")
dirs = json.load(open(plans / f"run-14d-{date}-dirs.json"))
ARMS = ["base-n12", "retr-n12", "base-n40", "retr-n40"]


def tasks_of(arm):
    plan = json.load(open(plans / f"project-a-{date}-{arm}" / "change_plan.json"))
    return plan, [t["task_id"] for s in plan["steps"] for t in s["tasks"]]


def survivors(arm, ids):
    run = dirs.get(arm) or ""
    if run == "":
        return 0, {"missing_run": True}
    verdicts = {}
    for f in sorted((Path(".sidecrew/runs") / run / "verdicts").glob("*.json")):
        v = json.load(open(f))
        verdicts.setdefault(v["task_id"].split("#")[0], []).append(v)
    k = sum(1 for t in ids if any(v["survived"] for v in verdicts.get(t, [])))
    result = json.load(open(Path(".sidecrew/runs") / run / "result.json"))
    return k, {
        "combined_regressions": result["project"]["combined_regressions"],
        "errors_before": result["project"]["errors_before"],
        "errors_after": result["project"]["errors_after"],
        "machine_failures": result["stats"].get("machine_failures"),
        "tasks_without_verdict": sum(1 for t in ids if t not in verdicts),
    }


def first_cache_read(transcript):
    """The first message's cache read: the harness a pass got back from a sibling's cache (prompt note, 25 Sep)."""
    for line in open(transcript):
        e = json.loads(line)
        if e.get("type") == "assistant":
            return e["message"].get("usage", {}).get("cache_read_input_tokens", 0) or 0
    return 0


rows = {}
for arm in ARMS:
    plan, ids = tasks_of(arm)
    transcript = os.environ.get("T_" + arm.upper().replace("-", "_"))
    if not transcript:
        sys.exit(f"set T_{arm.upper().replace('-', '_')} to that planner's subagent transcript")
    d = decompose.decompose(transcript)
    n = len(ids)
    k, run = survivors(arm, ids)
    shared = first_cache_read(transcript)
    normalised = d["P_total"] + shared
    rows[arm] = {
        "N": n,
        "P_total": d["P_total"],
        "R_as_measured": round(d["P_total"] / n / W_UPPER, 3) if n else None,
        "harness_from_sibling_cache": shared,
        "P_total_normalised": normalised,
        # §3 is applied to this one: what a pass started alone pays (prompt note, 25 Sep ~00:20).
        "R": round(normalised / n / W_UPPER, 3) if n else None,
        "split": {x: d[x] for x in ("harness", "reading", "output", "output_counted_twice", "residual")},
        "reading_by_tool": d["reading_by_tool"],
        "retrieval_calls": d["retrieval_calls"],
        "shapes": {s: sum(1 for st in plan["steps"] for t in st["tasks"] if t.get("shape") == s)
                   for s in {t.get("shape") for st in plan["steps"] for t in st["tasks"]}},
        "survived": k,
        "run": run,
    }

void = [a for a in ("base-n12", "base-n40") if rows[a]["retrieval_calls"] > 0]
s0 = rate(rows["base-n12"]["survived"] + rows["base-n40"]["survived"], rows["base-n12"]["N"] + rows["base-n40"]["N"])
s1 = rate(rows["retr-n12"]["survived"] + rows["retr-n40"]["survived"], rows["retr-n12"]["N"] + rows["retr-n40"]["N"])
r1 = rows["retr-n12"]["R"]

if s0["n"] < 20 or s1["n"] < 20:
    veto = "INCONCLUSIVE — a pooled n is below 20 (§3); the fork is applied to R₁ with this stated"
elif s1["ci95"][1] < s0["k"] / s0["n"]:
    veto = "FIRES — S₁'s upper bound is below S₀'s point estimate: STOP for retrieval as built (§3)"
else:
    veto = "does not fire"

if veto.startswith("FIRES"):
    fork = "STOP for retrieval as built — the quality veto overrides every row"
elif r1 is None:
    fork = "UNDEFINED — the retrieval arm at N ≈ 12 has no tasks"
elif r1 <= 1.0:
    fork = "PROCEED: cut v1.0.0 — once ADR-0089 is also closed"
elif r1 <= 2.0:
    fork = "INSERT 14d′ — ADR-0090 §5 option B: sidecrew expands the plan (output term), reading cache second. 1.0 waits"
else:
    fork = "STOP — publish v0.x describing the plan sizes where coordination does pay"

report = {
    "measured": True,
    "experiment": "phase-14d-retrieval",
    "rule": "docs/plan/prompts/phase-14d-retrieval.md §2–§3, frozen 24 Sep 2026",
    "date": date,
    "sidecrew_commit": subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip(),
    "machine": {"platform": platform.platform(), "node": subprocess.run(["node", "-v"], capture_output=True, text=True).stdout.strip()},
    "W_upper": W_UPPER,
    "arms": rows,
    "void_base_transcripts": void,
    "S0": s0, "S1": s1,
    "R1_at_N12": r1, "R0_at_N12": rows["base-n12"]["R"],
    "R1_at_N12_as_measured": rows["retr-n12"]["R_as_measured"],
    "normalisation": "R is harness-normalised: P_total plus the first message's cache read (prompt file note, 25 Sep ~00:20, written before R₁ existed)",
    "veto": veto,
    "fork": fork if not void else f"VOID — base transcript(s) {void} used retrieval; re-run those passes before reading anything",
    "prediction_preregistered": "R₁ in (1.5, 2.3)",
}
Path(out).write_text(json.dumps(report, indent=2, ensure_ascii=False))
print(json.dumps({k: report[k] for k in ("R1_at_N12", "R0_at_N12", "S0", "S1", "veto", "fork", "void_base_transcripts")}, indent=2, ensure_ascii=False))
for arm in ARMS:
    r = rows[arm]
    print(f"{arm:9s} N={r['N']:3d} P_total={r['P_total']:>8,} (+{r['harness_from_sibling_cache']:,}) R={r['R']} (as measured {r['R_as_measured']}) survived={r['survived']} retrieval_calls={r['retrieval_calls']}")
