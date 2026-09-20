#!/usr/bin/env python3
"""Phase 14b — read a probe's run directory and write the result file §5 asks for.

    python3 scripts/results-14b.py <run-dir> <probe-name> <out.json>

`S14` is null_guard survival over the **declared 30**, not over the tasks that produced a verdict. A
task whose verdict is missing counts as a non-survivor and is named in `missing`: a denominator that
quietly shrinks to the tasks that happened to finish is how a run reports a better rate than it earned,
and at n = 30 dropping three tasks moves the point estimate by more than the 0.10 threshold is wide.

**The run id is stripped.** It is built from the project directory's name, so it carries the client
into a file that looks like nothing but numbers (CLAUDE.md #7, caught twice in Phase 12). So are the
per-task file paths: the task ids are ours, the paths are not.
"""
import json
import os
import sys
import glob
from datetime import datetime, timezone


def crosses_calendar_day(v: dict) -> "bool | None":
    """`crossesCalendarDay` from src/schemas.ts, reproduced exactly rather than approximated.

    Two details are the whole point and both are easy to get wrong. It compares **local** calendar
    days, because the suite's notion of *today* is the running process's, not UTC's — and a UTC
    comparison would have reported 0 crossings on a run that crossed at 02:00 local. And it answers
    `None`, not `False`, when a timestamp is missing: a verdict written before ADR-0069 cannot
    answer, and `False` would be claiming it had.

    Re-deriving a writer's function instead of using it is how `safeName` produced a confident and
    completely wrong INCONCLUSIVE (HANDOFF § Standing hazards). This is a Python harness reading a
    TypeScript writer's output, so it cannot call the original; reproducing it under its own name,
    with the reason, is the next best thing.
    """
    a, b = v.get("baseline_captured_at"), v.get("verified_at")
    if a is None or b is None:
        return None
    def day(iso: str) -> tuple:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()
        return (d.year, d.month, d.day)
    return day(a) != day(b)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# The interval function is Phase 11b's, validated there against a published figure. A second
# implementation of an exact binomial interval is a second thing to be wrong.
_ns: dict = {}
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "results-11b.py")) as fh:
    exec(compile(fh.read(), "results-11b.py", "exec"), _ns)  # noqa: S102 — our own file, not input
clopper_pearson = _ns["clopper_pearson"]


def main() -> int:
    if len(sys.argv) != 4:
        sys.stderr.write("usage: results-14b.py <run-dir> <probe-name> <out.json>\n")
        return 1
    run_dir, probe, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

    result = json.load(open(os.path.join(run_dir, "result.json")))
    # The declared ids come from the plan, always. `result.json`'s `steps[].tasks` is a *count*, and
    # reading the denominator off the run's own summary would make it whatever the run managed to do.
    plan = json.load(open(result["plan"]))
    declared = [t["task_id"] for s in plan["steps"] for t in s["tasks"]]

    verdicts: dict[str, list[dict]] = {t: [] for t in declared}
    for f in sorted(glob.glob(os.path.join(run_dir, "verdicts", "*.json"))):
        v = json.load(open(f))
        base = v["task_id"].split("#")[0]
        if base in verdicts:
            verdicts[base].append(v)

    rows, survived, missing = [], 0, []
    machine_rows: list[tuple[dict, dict]] = []
    stages: dict[str, int] = {}
    breaches: dict[str, int] = {}
    crossed = 0
    crossing_unknown = 0
    for t in declared:
        vs = verdicts[t]
        if not vs:
            missing.append(t)
            rows.append({"task_id": t, "survived": False, "stage_reached": None, "attempts": 0,
                         "note": "no verdict — counted as a non-survivor, not dropped"})
            continue
        ok = any(v["survived"] for v in vs)
        survived += 1 if ok else 0
        last = vs[-1]
        stages[last["stage_reached"]] = stages.get(last["stage_reached"], 0) + 1
        for v in vs:
            # A list of {rule, file, detail}. Only `rule` is taken: `file` and `detail` quote the
            # client's tree, and this file is published.
            for c in (v.get("confinement") or []):
                breaches[c["rule"]] = breaches.get(c["rule"], 0) + 1
            m = v.get("machine") or {}
            if m.get("before") and m.get("after"):
                machine_rows.append((m["before"], m["after"]))
            x = crosses_calendar_day(v)
            if x is True:
                crossed += 1
            elif x is None:
                crossing_unknown += 1
        rows.append({"task_id": t, "survived": ok, "stage_reached": last["stage_reached"],
                     "attempts": len(vs)})

    n = len(declared)
    lo, hi = clopper_pearson(survived, n)
    baseline_lo, baseline_hi = clopper_pearson(1, 30)
    s14 = survived / n if n else 0.0

    if s14 >= 0.30:
        verdict = "INSERT 14b' — make this probe the default (PHASES.md § 14b)"
    elif s14 >= 0.10:
        verdict = "PROCEED to 14c; record the shape as 'improvable but not usable' (PHASES.md § 14b)"
    else:
        verdict = "PROCEED to 14c; write the ceiling down as a product fact (PHASES.md § 14b). A complete result."

    payload = {
        "measured": True,
        "experiment": "editing-ceiling",
        "section": "Phase 14b",
        "probe": probe,
        "rule": "experiments/editing-ceiling/README.md §1, copied verbatim from docs/plan/PHASES.md "
                "§ 14b before either probe ran",
        "commit": os.popen("git rev-parse HEAD").read().strip(),
        "project": "project-a",
        "compiler_flags": result.get("config", {}).get("compiler_flags") or ["--strictNullChecks"],
        "compiler_flags_note": "ADR-0063. No figure here may share a table cell with one taken under "
                               "the project's own configuration.",
        "worker": {
            "tier": result["config"].get("worker_kind"),
            "model": result["config"].get("worker_model"),
            "concurrency": result["config"].get("concurrency"),
            "tokens": result.get("stats", {}).get("claude_tokens", {}).get("workers", 0),
        },
        "task_set": {
            "N": n,
            "shape_mix": {"null_guard": n},
            "source": "experiments/correction-round/plans/project-a-2026-09-20/change_plan.json — "
                      "the SAME 30 declared tasks §2.2 used; gitignored, never regenerated",
        },
        "S14": round(s14, 4),
        "S14_count": f"{survived} of {n}",
        "S14_interval_95": [round(lo, 4), round(hi, 4)],
        "baseline": {
            "S": round(1 / 30, 4), "count": "1 of 30",
            "interval_95": [round(baseline_lo, 4), round(baseline_hi, 4)],
            "source": "experiments/correction-round/results/correction-round-2026-09-20.json pass1",
        },
        "interval_note": "Exact Clopper-Pearson. At n = 30 the intervals for 3/30 and 6/30 overlap, so "
                         "0.30 is a decision rule and not a claim of precision.",
        "gate_error_rate_D": 0.105,
        "gate_error_rate_note": "Measured on #2a's gate (ADR-0066/0069 era) and this is #2a's gate. Not "
                                "negligible against the 0.10 threshold.",
        "funnel": result.get("stats", {}).get("funnel"),
        "confinement_breaks": breaches,
        "stage_reached": stages,
        "truncated": result.get("stats", {}).get("edit_truncated"),
        "unparsed": result.get("stats", {}).get("edit_parse_failed"),
        "refusals": result.get("stats", {}).get("refusals"),
        "machine_failures": result.get("stats", {}).get("machine_failures"),
        "latency_ms": result.get("stats", {}).get("latency_ms"),
        "generate_ms": result.get("stats", {}).get("generate_ms"),
        "missing_verdicts": missing,
        "missing_note": "Counted as non-survivors. The denominator is the declared 30 in every case.",
        "adr_0069_verdicts_crossing_midnight": crossed,
        "adr_0069_verdicts_cannot_answer": crossing_unknown,
        "adr_0069_note": "Local calendar days, as src/schemas.ts crossesCalendarDay compares them. A "
                         "crossing only threatens a verdict that reached the suite, which unlike §2.2 "
                         "is the expected case for a probe that works.",
        # ADR-0066: the measurement destroying its own instrument. Reported from the fields rather
        # than asserted, because "the machine was quiet" is exactly the claim a contended run makes.
        "adr_0066_machine": {
            "free_gb_min": round(min((b["free_gb"] for b, _ in machine_rows), default=0.0), 2),
            "free_gb_max": round(max((a["free_gb"] for _, a in machine_rows), default=0.0), 2),
            "swap_gb_first": round(machine_rows[0][0]["swap_gb"], 2) if machine_rows else None,
            "swap_gb_last": round(machine_rows[-1][1]["swap_gb"], 2) if machine_rows else None,
            "pressure_not_normal": sum(
                1 for b, a in machine_rows
                if b.get("pressure") != "normal" or a.get("pressure") != "normal"
            ),
        },
        "per_task": rows,
        "verdict": verdict,
    }

    with open(out_path, "w") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")

    blob = json.dumps(payload)
    # Names come from the environment, never from this file: CLAUDE.md #7 keeps them in the
    # memory directory and out of every tracked blob.
    for name in [n for n in os.environ.get("SIDECREW_CLIENT_NAMES", "").split(",") if n]:
        if name in blob.lower():
            sys.stderr.write(f"REFUSING to leave a client name in {out_path}: found {name!r}\n")
            return 2

    print(f"{probe}: S14 = {survived}/{n} = {s14:.4f}  95% [{lo:.4f}, {hi:.4f}]")
    print(f"  baseline 1/30 = 0.0333  95% [{baseline_lo:.4f}, {baseline_hi:.4f}]")
    print(f"  -> {verdict}")
    if missing:
        print(f"  {len(missing)} task(s) had no verdict and count as non-survivors: {', '.join(missing)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
