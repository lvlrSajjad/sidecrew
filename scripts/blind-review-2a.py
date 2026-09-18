#!/usr/bin/env python3
"""§4.1's blind approval rate A(x): draw each configuration's sample, then shuffle them into one pass.

    scripts/blind-review-2a.py draw  <input>          # emit the blind pack for one project
    scripts/blind-review-2a.py score <input>          # apply the recorded verdicts and print A(x)

**Why this is a script and not a judgement call made while reading.** A(x) is a veto in the frozen rule
(§4.3), so the one thing that must not happen is the reviewer learning which arm wrote a diff. The draw
is `auditDraw` from `src/review.ts` — sha256(`run_id:task_id`), first 52 bits — so the sample is a
property of the run rather than of who is looking, and re-running this picks the same survivors. The
pack is then ordered by a hash of the diff text, which is independent of configuration, and each item
gets an opaque id. The mapping from id back to configuration is written to a separate file that the
reviewer does not open until `score`.

`min(10, survivors)` per configuration, as §4.1 says.
"""
import glob, hashlib, json, os, re, sys

SP = "experiments/go-no-go-2a"
PARTIALS = f"{SP}/results/partials"
PACKS = f"{SP}/review"


def audit_draw(run_id: str, task_id: str) -> float:
    """src/review.ts `auditDraw`, ported exactly: first 52 bits of sha256 over 2^52."""
    d = hashlib.sha256(f"{run_id}:{task_id}".encode()).digest()
    return (int.from_bytes(d[:8], "big") >> 12) / 2 ** 52


def load(config: str, input_id: str):
    p = f"{PARTIALS}/{config}-{input_id}.json"
    return json.load(open(p)) if os.path.exists(p) else None


def local_path(run_id: str, task_id: str, diff_path: str) -> str:
    """Find a survivor's diff on this machine, given a redacted partial.

    The partial is committed, so its paths are redacted (CLAUDE.md #7); the run directory under
    `.sidecrew/` is gitignored and keeps the project's real name. Rather than un-redact a path, this
    rebuilds one from two fields redaction leaves structurally intact — the run's **timestamp**, which
    is unique and identifies nobody, and the **task id**.

    Redacting a value that is also a key broke three consumers before this one. The rule that came out
    of it, and it is in the report: redact at the boundary, and join on something the boundary does
    not touch.
    """
    if os.path.exists(diff_path):
        return diff_path
    stamp = run_id.split("Z-", 1)[0] + "Z-"
    hits = sorted(glob.glob(f".sidecrew/runs/{stamp}*/diffs/{task_id}.diff"))
    return hits[0] if len(hits) == 1 else diff_path


def draw(input_id: str) -> None:
    os.makedirs(PACKS, exist_ok=True)
    items, key = [], {}
    for config in ("c2", "c2b", "c3"):
        part = load(config, input_id)
        if part is None:
            continue
        result = part["result"]
        run_id = result["run_id"]
        survivors = result["survivors"]
        ranked = sorted(survivors, key=lambda s: audit_draw(run_id, s["task_id"]))
        sample = ranked[: min(10, len(ranked))]
        print(f"{config}: {len(survivors)} survivor(s), sampling {len(sample)}")
        for s in sample:
            dp = local_path(run_id, s["task_id"], s["diff_path"])
            diff = open(dp).read() if os.path.exists(dp) else "(diff missing)"
            # An opaque id: the reviewer must not be able to read the arm off the label.
            oid = hashlib.sha256(f"{config}:{run_id}:{s['task_id']}".encode()).hexdigest()[:10]
            items.append({"id": oid, "task_id": s["task_id"], "files": s["files"], "diff": diff})
            key[oid] = {"config": config, "task_id": s["task_id"], "run_id": run_id}

    # Ordered by a hash of the diff itself: independent of configuration and of insertion order.
    items.sort(key=lambda i: hashlib.sha256(i["diff"].encode()).hexdigest())

    # `api` -> project-a, `web` -> project-b. The plans are named for the anonymised projects, which is
    # also what the results reference (CLAUDE.md #7).
    projects = {"api": "project-a", "web": "project-b"}
    plan = json.load(open(f"{SP}/plans/{projects[input_id]}.json")) if input_id != "fixture" else \
        json.load(open("fixtures/fix-fixture/plans/fix-type-errors.json"))
    asks = {t["task_id"]: t["ask"] for st in plan["steps"] for t in st["tasks"]}
    # From the plan, not from the partial. The partial is redacted (CLAUDE.md #7) while the diffs are
    # read unredacted from disk, and a pack that mixes the two invents a mismatch between the file a
    # task names and the file its diff touches — which a reviewer correctly rejects, scoring the
    # harness rather than the model. The pack is gitignored precisely so it can be consistent.
    task_files = {t["task_id"]: t["files"] for st in plan["steps"] for t in st["tasks"]}

    with open(f"{PACKS}/{input_id}-pack.md", "w") as f:
        f.write(f"# Blind review pack — {input_id}\n\n")
        f.write("Each item is a change that survived the 2a gate. For each, answer **one** question:\n\n")
        f.write("> Would you have accepted this as the change that was asked for?\n\n")
        f.write("You are not told which worker wrote which diff, and you must not try to infer it.\n\n")
        for i in items:
            base = i["task_id"].split("#")[0]
            f.write(f"\n---\n\n## {i['id']}\n\n**Ask:** {asks.get(base, '(unknown)')}\n\n")
            f.write(f"**Files:** {', '.join(task_files.get(base, i['files']))}\n\n```diff\n{i['diff']}\n```\n")
    json.dump(key, open(f"{PACKS}/{input_id}-key.json", "w"), indent=2)
    print(f"\npack  → {PACKS}/{input_id}-pack.md   ({len(items)} items)")
    print(f"key   → {PACKS}/{input_id}-key.json   (do not open until scoring)")


def score(input_id: str) -> None:
    key = json.load(open(f"{PACKS}/{input_id}-key.json"))
    verdicts = json.load(open(f"{PACKS}/{input_id}-verdicts.json"))
    by_config: dict[str, list[bool]] = {}
    for oid, accepted in verdicts.items():
        if oid not in key:
            sys.exit(f"verdict for unknown id {oid}")
        by_config.setdefault(key[oid]["config"], []).append(bool(accepted))
    missing = set(key) - set(verdicts)
    if missing:
        sys.exit(f"{len(missing)} item(s) not reviewed: {sorted(missing)}")
    print(f"A({input_id}):")
    for config, vs in sorted(by_config.items()):
        n, k = len(vs), sum(vs)
        print(f"  {config}: {k}/{n} = {k / n:.3f}")


if __name__ == "__main__":
    mode, input_id = sys.argv[1], sys.argv[2]
    (draw if mode == "draw" else score)(input_id)
