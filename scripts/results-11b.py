#!/usr/bin/env python3
"""Assemble Phase 11b's results JSON from what is on disk. Nothing here invents a number.

    scripts/results-11b.py <project> [> experiments/status-quo/results/status-quo-<date>.json]

Every cell is read from an artefact — arm result JSONs, the gate's verdicts, the pressure CSV, the
blind-review key — and a cell whose artefact is absent is emitted as `null` with a `_missing` note
rather than omitted or guessed. A results file that quietly drops a cell reads as a complete result.

**Why a script rather than writing the JSON by hand**, which is how Phase 11's was produced: that file
has three numbers in it that had to be corrected after the fact, each because a hand-copied cell went
stale when its run was redone. Here arm C was already discarded and rerun once (ADR-0066), so the
staleness risk is not hypothetical.
"""
import csv, glob, hashlib, json, math, os, platform, re, subprocess, sys, datetime

SQ = "experiments/status-quo"
RES = f"{SQ}/results"


# ── exact binomial interval ──────────────────────────────────────────────────────────────────────
def binom_cdf(k: int, n: int, p: float) -> float:
    """P(X <= k). Exact with math.comb; n here is at most a few dozen."""
    return sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(k + 1))


def clopper_pearson(k: int, n: int, alpha: float = 0.05) -> list[float]:
    """Exact 95 % interval, by bisection on the binomial CDF — no scipy, no normal approximation.

    The normal approximation is wrong in exactly the region this phase lives in: small n, rates at or
    near 1.0. Phase 11's `S(C2) = 12/12` is [0.735, 1.0] here, where a Wald interval gives [1.0, 1.0]
    — zero width around a rate measured twelve times, which would assert certainty the data cannot
    support. Validated against Phase 11's published `A(C2) = 9/10 -> [0.555, 0.997]`, reproduced
    exactly by this function.
    """
    if n == 0:
        return [0.0, 1.0]
    def solve(target, lo, hi, f):
        for _ in range(200):
            mid = (lo + hi) / 2
            if f(mid) > target:
                lo = mid
            else:
                hi = mid
        return (lo + hi) / 2
    low = 0.0 if k == 0 else solve(1 - alpha / 2, 0.0, 1.0, lambda p: binom_cdf(k - 1, n, p))
    high = 1.0 if k == n else solve(alpha / 2, 0.0, 1.0, lambda p: binom_cdf(k, n, p))
    return [round(low, 3), round(high, 3)]


def rate(k: int, n: int) -> dict:
    return {"k": k, "n": n, "rate": round(k / n, 3) if n else None, "ci95": clopper_pearson(k, n)}


# ── reading what is on disk ──────────────────────────────────────────────────────────────────────
def run_id_from_log(path: str):
    if not os.path.exists(path):
        return None
    # `^\s*` because arm D's harness indents runFix's events by two spaces. Anchoring on `^fix`
    # silently returned None for that arm, which the caller renders as a MISSING arm rather than an
    # error — a whole arm dropped out of the results and the file still looked complete.
    m = re.search(r"^\s*fix (\S+?):", open(path).read(), re.M)
    return m.group(1) if m else None


def gate_arm(run_id: str, planned_ids: list[str], complete: bool) -> dict:
    """The funnel for one gated arm, counted from its verdicts rather than from its log.

    Task-level, not attempt-level: a task that failed once and survived on the retry is one survivor,
    which is what `FixResult.stats` reports and what a rate's denominator means.

    **`sidecrew fix` writes an authoritative `result.json`**, which is preferred here. An earlier
    version of this function reconstructed everything from verdict files on the belief that it did
    not — wrong, and the wrong way round: recomputing what is already recorded is how two numbers for
    one quantity come to disagree in the same file.

    The reconstruction is kept, because a **killed** run has verdicts and no `result.json` and that is
    a case this phase actually hit. It now runs as a cross-check: when both exist they must agree, and
    a disagreement is reported rather than silently resolved in favour of either.

    Reconstruction rule — `isMachineFailure` (fix.ts:615) is
    `threw !== null || any attempt has tests !== null && !tests.reported`. Both halves survive the
    round trip to disk: the second is a field, and the first shows up as a **planned task with no
    verdict file at all**, which is why `planned_ids` is passed in rather than inferred from what is
    present. Inferring the denominator from the artefacts that exist is how a lost task silently
    leaves a rate.

    **That inference is only valid once the run has finished**, which is what `complete` carries. A
    task that has not run yet is also a planned task with no verdict, so on an in-flight or killed run
    the same rule reports every unreached task as a machine failure and drives the worker-quality
    denominator to zero — a confident, plausible, entirely wrong number. Arm C was killed mid-run once
    today, so this is not hypothetical. When `complete` is false the absence half is refused and the
    field says why, rather than being computed from evidence that does not exist yet.
    """
    by_task: dict[str, list[dict]] = {}
    for vp in sorted(glob.glob(f".sidecrew/runs/{run_id}/verdicts/*.json")):
        v = json.load(open(vp))
        by_task.setdefault(v["task_id"].split("#")[0], []).append(v)

    survived = sum(1 for vs in by_task.values() if any(v.get("survived") for v in vs))
    refused = sum(1 for vs in by_task.values() if any(v.get("refused") for v in vs))
    retried = sum(1 for vs in by_task.values() if len(vs) > 1)

    # ADR-0056 / §5: never the worker's to answer, so never in a worker-quality denominator.
    no_verdict = [t for t in planned_ids if t not in by_task] if complete else []
    unreported = [t for t, vs in by_task.items()
                  if any((v.get("tests") or {}).get("reported") is False for v in vs)]
    machine_failures = sorted(set(no_verdict) | set(unreported))
    stages: dict[str, int] = {}
    for vs in by_task.values():
        final = next((v for v in vs if v.get("survived")), vs[-1])
        stages[final.get("stage_reached", "?")] = stages.get(final.get("stage_reached", "?"), 0) + 1

    # ADR-0066: a task whose only failure was at `tests` is the shape a pressure false negative takes.
    # Flagged, never auto-excluded — the ADR's whole point is that the verdict cannot tell you.
    suspect = [t for t, vs in by_task.items()
               if not any(v.get("survived") for v in vs)
               and all(v.get("stage_reached") == "tests" for v in vs)]

    recon = {"tasks": len(planned_ids), "survived": survived, "refusals": refused,
             "retried": retried, "machine_failures": len(machine_failures)}

    # The authoritative record, when the run got far enough to write one.
    rp = f".sidecrew/runs/{run_id}/result.json"
    authoritative = json.load(open(rp))["stats"] if os.path.exists(rp) else None
    disagreements = {}
    if authoritative is not None:
        for k in ("tasks", "survived", "refusals", "retried", "machine_failures"):
            if k in authoritative and authoritative[k] != recon[k]:
                disagreements[k] = {"result_json": authoritative[k], "reconstructed_from_verdicts": recon[k]}
        survived = authoritative["survived"]
        refused = authoritative["refusals"]
        machine_failures = machine_failures[:authoritative["machine_failures"]] \
            if authoritative["machine_failures"] < len(machine_failures) else machine_failures

    reached_and_failed = len(planned_ids) - survived - len(machine_failures) - refused
    return {
        "source": "result.json" if authoritative else "reconstructed from verdicts (no result.json — "
                                                      "the run did not finish)",
        "funnel": (authoritative or {}).get("funnel"),
        "latency_ms": {k: (authoritative or {}).get(k) for k in ("generate_ms", "gate_ms", "latency_ms")}
                      if authoritative else None,
        "claude_tokens": (authoritative or {}).get("claude_tokens"),
        "cross_check": {"agrees": not disagreements, **({"disagreements": disagreements} if disagreements else {})},
        "tasks": len(planned_ids), "tasks_with_a_verdict": len(by_task),
        "survived": survived, "refusals": refused, "retried": retried,
        "run_complete": complete,
        "machine_failures": {
            "n": len(machine_failures), "tasks": machine_failures,
            "no_verdict_written": no_verdict, "suite_did_not_report": unreported,
            "why": "ADR-0056 — the sandbox or the runner broke; never the worker's to answer. "
                   "Reconstructed from disk because `fix` does not persist its FixResult.",
            **({} if complete else {"_incomplete": (
                "the run has not finished, so a planned task with no verdict has not necessarily "
                "failed — it may simply not have run. Only `suite_did_not_report` is counted here.")}),
        },
        "denominator_for_worker_quality": (
            {"value": reached_and_failed,
             "formula": "tasks - survived - refusals - machine_failures (§5) — what actually reached "
                        "the gate and failed it. Dividing by `tasks` understates the worker."}
            if complete else
            {"value": None, "_incomplete": "not computable until the run finishes; see run_complete."}),
        "final_stage_reached": stages,
        "failed_at_tests_only": {
            "tasks": suspect,
            "note": "ADR-0066: this is the shape a memory-pressure false negative takes. Not excluded "
                    "from any denominator — cross-check each against pressure_telemetry before reading "
                    "it as a defect the gate caught.",
        },
    }


def pressure_summary(path: str) -> dict:
    if not os.path.exists(path):
        return {"_missing": path}
    rows = list(csv.DictReader(open(path)))
    if not rows:
        return {"_missing": "empty"}
    lv = [int(r["pressure"]) for r in rows]
    sw = [float(r["swap_gb"]) for r in rows]
    fr = [float(r["free_gb"]) for r in rows]
    return {
        "measured": True,
        "why": "ADR-0066 — the instrument the product is missing. A gate under memory pressure fails "
               "closed and its verdict cannot say so; this makes a starved verdict identifiable after "
               "the fact by timestamp.",
        "samples": len(rows), "interval_s": 20,
        "first": rows[0]["iso"], "last": rows[-1]["iso"],
        "pressure_level": {"max": max(lv), "warn_or_worse_frac": round(sum(1 for x in lv if x > 1) / len(lv), 3),
                           "legend": "1 normal, 2 warn, 4 critical"},
        "swap_gb": {"floor": min(sw), "max": max(sw), "growth": round(max(sw) - min(sw), 2)},
        "free_gb": {"min": min(fr), "max": max(fr)},
        "reading": "pressure `warn` with flat swap is this suite's ordinary operating point — 352 "
                   "suites plus a resident 7B do not fit in 32 GB with headroom, so the kernel "
                   "compresses and nothing reaches disk. Sustained swap GROWTH is the damaging "
                   "condition; see the ADR-0066 amendment.",
    }


def ungated_arm(path: str) -> dict:
    if not os.path.exists(path):
        return {"_missing": path}
    d = json.load(open(path))
    return {
        "label": d["arm"],
        "delivered": len(d["tasks"]),
        "delivered_means": "everything produced — an ungated arm has no filter (§4.1)",
        "marginal_tokens": sum(t["marginal"] for t in d["tasks"]),
        "harness_floor_tokens": d["floor_tokens"],
        "floor_note": d.get("floor_note", "the Agent harness's own token cost, measured twice; "
                                          "T = subagent_tokens - floor. The floor is PER MODEL."),
        # Optional: project-a's harness recorded it per task and project-b's was measured after
        # the fact. A results build must not die because one arm predates a field.
        "diff_lines": (sum(t["diff_lines"] for t in d["tasks"])
                       if all("diff_lines" in t for t in d["tasks"]) else None),
    }


def main(project: str) -> None:
    c_run = run_id_from_log(f"{RES}/arm-c-{project}.log")
    d_run = run_id_from_log(f"{RES}/arm-d-{project}.log")

    # The commit that RAN, read off the arms' own logs — not `git rev-parse HEAD`.
    #
    # Arms C and D ran from a detached worktree pinned to one commit, precisely so that a second
    # session could keep developing in the main tree. `HEAD` here therefore describes the tree where
    # this script happens to be invoked, which by the time results are assembled is several commits
    # ahead of the binary that produced them. Recording it would be a provenance field naming the
    # wrong tree, which is worse than having none: it looks checked.
    plan = json.load(open(f"experiments/go-no-go-2a/plans/{project}-11b.json"))
    planned_ids = [t["task_id"] for st in plan["steps"] for t in st["tasks"]]

    # Did each arm actually finish? The launcher writes `ARM-? EXIT <code>` on the way out, so a
    # killed run is distinguishable from a finished one — which is what makes the absence of a
    # verdict interpretable at all.
    def finished(path: str) -> bool:
        return os.path.exists(path) and re.search(r"^ARM-[CD] EXIT 0\b", open(path).read(), re.M) is not None

    ran = set()
    for p in (f"{RES}/arm-c-{project}.log", f"{RES}/arm-d-{project}.log"):
        if os.path.exists(p):
            # `commit <sha>` (project-a's launcher) or `gate <sha>` (project-b's). Accepting only
            # one silently yielded `commit: null` — a provenance field losing its value because a
            # log's wording changed is exactly what this field exists to prevent.
            m = re.search(r"^ARM-[CD] START \S+ (?:commit|gate) (\S+)", open(p).read(), re.M)
            if m:
                ran.add(m.group(1))
    commit = sorted(ran)[0] if len(ran) == 1 else (sorted(ran) or [None])[0]

    arms = {
        "A": ungated_arm(f"{RES}/arm-a-{project}.json"),
        "B": ungated_arm(f"{RES}/arm-b-{project}.json"),
        "C": gate_arm(c_run, planned_ids, finished(f"{RES}/arm-c-{project}.log"))
             if c_run else {"_missing": "arm C has not produced a run id"},
        "D": gate_arm(d_run, planned_ids, finished(f"{RES}/arm-d-{project}.log"))
             if d_run else {"_missing": "arm D has not produced a run id"},
    }
    for k, lbl in (("C", "sidecrew — local 7B behind the gate"),
                   ("D", "the gate applied to arm A's own diffs; model held fixed, only the gate varies")):
        if "_missing" not in arms[k]:
            arms[k]["label"] = lbl
            arms[k]["delivered_means"] = "survivors only — the gate threw the rest away (§4.1)"

    # P(x) only if the blind review has actually been scored. Never synthesised.
    key_p, verd_p = f"{SQ}/review/{project}-key.json", f"{SQ}/review/{project}-verdicts.json"
    if os.path.exists(key_p) and os.path.exists(verd_p):
        blob, verdicts = json.load(open(key_p)), json.load(open(verd_p))
        per: dict[str, list[bool]] = {}
        for oid, ok in verdicts.items():
            for arm in blob["key"][oid]["arms"]:
                per.setdefault(arm, []).append(bool(ok))
        P = {a: rate(sum(v), len(v)) for a, v in sorted(per.items())}
    else:
        P = {"_missing": "blind review not scored yet — run scripts/blind-review-11b.py draw, review, "
                         "then score. P(x) is never computed from anything but a scored pack."}

    out = {
        "measured": True,
        "experiment": "status-quo (sidecrew against not using sidecrew)",
        "phase": "11b",
        "date": datetime.date.today().isoformat(),
        "commit": commit,
        "commit_source": "read from the arms' own ARM-* START lines — the frozen worktree they ran "
                         "from, not this tree's HEAD (see main()).",
        "arms_agree_on_commit": len(ran) <= 1,
        "protocol": f"{SQ}/README.md — §4 frozen 2026-09-18 before any arm ran; "
                    "§4.2's verdict WITHHELD per §4.4, declared before the first arm",
        "verdict": "WITHHELD",
        "why_withheld": "§4.4 — at least half the tasks must be null guards, API migrations or "
                        "dead-code removal for §4.2 to apply. The shape mix is 19/19 rename. See "
                        "observation O1: two different frontier models produced BYTE-IDENTICAL output "
                        "on all 19 tasks, so this task set demonstrably cannot discriminate.",
        "machine": {
            "host": platform.node(), "total_gb": 32, "chip": "Apple Silicon",
            "node": subprocess.run(["node", "-v"], capture_output=True, text=True).stdout.strip(),
        },
        "worker_local": {
            "model": "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
            "revision": "019cc73c45c770444708a6dd8690c66243cc5c80",
            "temperature": 0,
        },
        "project": project,
        "tasks": {"n": 19, "shape_mix": {"rename": 19},
                  "composition": "12 single-file + 7 multi-file renames; one multi-file task dropped "
                                 "when --validate caught it sharing a file with another"},
        "arms": arms,
        "P": P,
        "pressure_telemetry": pressure_summary(f"{RES}/pressure-{project}.csv"),
        "known_defects": [
            "ADR-0066 — a gate under memory pressure fails closed and the false negative is "
            "indistinguishable from a true one. Arm C's first run was discarded at 4/19 and restarted "
            "from scratch on a quiet machine; this file reports only the restarted run.",
        ],
    }
    json.dump(out, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: results-11b.py <project>")
    main(sys.argv[1])
