#!/usr/bin/env python3
"""Phase 14b — sort a probe's compile failures into "the model failed" and "nobody could pass".

    python3 scripts/editing-ceiling-classify.py <run-dir> <plan.json> [out.json]

**Why this exists.** ADR-0071: a task's file can be fixed perfectly and the gate still fails, because
a *test* file the plan may never list gains an error when the target's type changes. §2.2 found 12 of
its 29 in that state. Those tasks are unsatisfiable by construction — their contribution to `S₁₄` is
guaranteed zero for a reason that says nothing about the worker — and a probe that reports a single
rate over both populations is answering a different question from the one 14b asks.

The classification is read off the verdict's own fields, never inferred from the diff:

- `remaining_in_target` — errors the ask covered that are still there. Non-empty means the worker did
  not do the job.
- `introduced` — errors that did not exist before. In the task's own files, the worker broke something.
  Only outside them, and with the target clean, the work was right and the gate could not say so.

**Neither population is dropped and `S₁₄` is not recomputed here.** §4.0 precondition 4 forbids
changing a set after seeing failures, and the denominator stays 30 in the result file. This is the
same device §2.2 used: report the clean subset so a reader can see it, without quietly adjusting the
number the rule is applied to.
"""
import json
import os
import sys
import glob


def main() -> int:
    if len(sys.argv) not in (3, 4):
        sys.stderr.write("usage: editing-ceiling-classify.py <run-dir> <plan.json> [out.json]\n")
        return 1
    run_dir, plan_path = sys.argv[1], sys.argv[2]
    out_path = sys.argv[3] if len(sys.argv) == 4 else None

    plan = json.load(open(plan_path))
    files_of = {t["task_id"]: set(t["files"]) for s in plan["steps"] for t in s["tasks"]}

    buckets: dict[str, list] = {
        "survived": [],
        "unsatisfiable_adr_0071": [],
        "target_not_fixed": [],
        "broke_the_target": [],
        "no_edit_at_all": [],
        "other": [],
    }

    for task_id, own in files_of.items():
        # The last attempt is the one the task is judged on; earlier ones are the free retry.
        cands = sorted(glob.glob(os.path.join(run_dir, "verdicts", f"{task_id}.json")) +
                       glob.glob(os.path.join(run_dir, "verdicts", f"{task_id}.[0-9].json")))
        if not cands:
            buckets["other"].append({"task_id": task_id, "why": "no verdict"})
            continue
        v = json.load(open(cands[-1]))

        if v["survived"]:
            buckets["survived"].append({"task_id": task_id})
            continue

        rules = {c["rule"] for c in (v.get("confinement") or [])}
        if "no_edit_at_all" in rules:
            buckets["no_edit_at_all"].append({"task_id": task_id, "attempts": len(cands)})
            continue

        errs = v.get("errors") or {}
        remaining = errs.get("remaining_in_target") or {}
        introduced = errs.get("introduced") or {}
        # Path spellings come from the compiler and the plan; compare as given, both POSIX here.
        inside = {f: n for f, n in introduced.items() if f in own}
        outside = {f: n for f, n in introduced.items() if f not in own}

        row = {
            "task_id": task_id,
            "attempts": len(cands),
            "stage_reached": v["stage_reached"],
            "remaining_in_target": sum(remaining.values()),
            "introduced_inside_task_files": sum(inside.values()),
            "introduced_outside": sum(outside.values()),
            # How many distinct files outside the task gained an error, without naming them: the
            # names are the client's tree (CLAUDE.md #7).
            "outside_file_count": len(outside),
        }

        # ADR-0071 is tested FIRST, because it is a property of the task rather than of the answer:
        # a file the plan may never list gained an error, so this task fails whatever the model did.
        # §2.2 counted its 12 this way and the buckets have to mean the same thing to be comparable.
        #
        # It is not the whole story for all of them, and the sub-field is why. Of §2.2's 12, five ALSO
        # left the target unfixed — unsatisfiable and badly answered at once. "Unsatisfiable" earns
        # those tasks no credit for the model, and a reader who wants the model's own record should
        # take `target_clean` rather than the bucket size.
        if outside:
            row["target_clean"] = not remaining and not inside
            row["also_failed_the_target"] = bool(remaining or inside)
            buckets["unsatisfiable_adr_0071"].append(row)
        elif remaining:
            buckets["target_not_fixed"].append(row)
        elif inside:
            buckets["broke_the_target"].append(row)
        else:
            buckets["other"].append(row)

    n = len(files_of)
    counts = {k: len(v) for k, v in buckets.items()}
    unsat = buckets["unsatisfiable_adr_0071"]
    unsat_target_clean = sum(1 for r in unsat if r.get("target_clean"))
    clean_n = n - counts["unsatisfiable_adr_0071"]
    payload = {
        "measured": True,
        "experiment": "editing-ceiling",
        "what": "compile-stage failures sorted by whose failure they are",
        "N": n,
        "counts": counts,
        "unsatisfiable_breakdown": {
            "total": counts["unsatisfiable_adr_0071"],
            "target_was_fixed_correctly": unsat_target_clean,
            "target_also_failed": counts["unsatisfiable_adr_0071"] - unsat_target_clean,
            "note": "Both are unsatisfiable and neither could have survived. The split says how many "
                    "of them the model nevertheless got right in the file it was asked about — which "
                    "is the only part that speaks to capability.",
        },
        "clean_subset": {
            "n": clean_n,
            "survived": counts["survived"],
            "note": "Tasks not excluded by ADR-0071. S14 is NOT recomputed on this denominator — the "
                    "rule is applied to 30. This is here so a reader can see the subset without the "
                    "number being quietly adjusted (§4.0 precondition 4).",
        },
        "per_task": buckets,
        "reading": {
            "target_not_fixed": "the worker did not do the job — a real model failure",
            "broke_the_target": "the worker changed the task's own files and made them worse",
            "unsatisfiable_adr_0071": "the target was fixed and a file the plan may never list gained "
                                      "an error. Guaranteed zero whatever the model does",
            "no_edit_at_all": "the file came back byte-identical — the 7B's dominant failure in §2.2",
        },
    }

    blob = json.dumps(payload).lower()
    generic = {"users", "coding", "home", "src", "repos", "projects", "documents", "work", "dev", ""}
    leaked = sorted({seg.lower() for seg in plan["project"].replace("\\", "/").split("/")
                     if seg.lower() not in generic and len(seg) > 2 and seg.lower() in blob})
    if leaked:
        sys.stderr.write(f"REFUSING to write: {len(leaked)} client path segment(s) in the payload\n")
        return 2

    if out_path:
        with open(out_path, "w") as fh:
            json.dump(payload, fh, indent=2)
            fh.write("\n")

    w = max(len(k) for k in counts)
    for k, c in counts.items():
        print(f"  {k:<{w}}  {c}")
    print(f"\n  of the {counts['unsatisfiable_adr_0071']} unsatisfiable: "
          f"{unsat_target_clean} had the target fixed correctly, "
          f"{counts['unsatisfiable_adr_0071'] - unsat_target_clean} also failed the target")
    print(f"  clean subset (ADR-0071 removed): {counts['survived']}/{clean_n}")
    print(f"  the rule is still applied to {counts['survived']}/{n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
