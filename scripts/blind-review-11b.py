#!/usr/bin/env python3
"""§4.1's blind precision P(x) for Phase 11b's four arms, in one shuffled pass per project.

    scripts/blind-review-11b.py draw  <project>       # emit the blind pack
    scripts/blind-review-11b.py score <project>       # apply recorded verdicts, print P(x) per arm

Phase 11's `blind-review-2a.py` cannot express this phase, for two reasons that are not cosmetic.

**1. "Delivered" means different things in different arms, and that asymmetry is the measurement.**
§4.1: for C and D, delivered means *survivors* — the gate threw the rest away. For A and B there is no
gate, so delivered means *everything they produced*. A person asking a frontier model directly gets all
19 changes, good and bad, and P(A) must be computed over all 19 or it flatters the ungated arm by
silently giving it a filter it does not have.

**2. Arm D's diffs ARE arm A's diffs, so reviewing both would be reviewing the same text twice.**
Arm D feeds arm A's edited files through the gate; it writes no new code. Two consequences:

  - A reviewer handed both packs would see every arm-D item a second time, adjacent (the pack is
    ordered by a hash of the diff text, so identical diffs sort together). That is unblinding by
    construction and it wastes half the reviewer's attention.
  - The judgement on a given diff cannot depend on which arm delivered it. It is the same text.

So this reviews **distinct diffs once** and attributes each judgement to **every arm that delivered
it**. P(A) is the mean over all 19; P(D) is the mean over the subset the gate passed — the *same*
judgements, two denominators. That isolates exactly what §3 says arm D is for: the gate's effect with
the model held fixed. Any other construction measures reviewer variance between two readings of one
diff and calls it the gate.

Dedup is by diff content across every arm, not just A/D — if two arms independently produce identical
text, it is one item and one judgement, counted for both.

**`observations` are never written to the pack** (§5, ADR-0057). They exist on gated arms only and
would tell the reviewer which arm wrote an item. Asserted below rather than left to care.
"""
import glob, hashlib, json, os, re, subprocess, sys, tempfile

SQ = "experiments/status-quo"
PACKS = f"{SQ}/review"
PLANS = "experiments/go-no-go-2a/plans"
SCRATCH = os.environ.get("SIDECREW_11B_SCRATCH", "")

# Fields that must never reach a reviewer. `observations` is the one §5 names; the rest are arm tells.
FORBIDDEN = ("observations", "worker", "arm", "model", "kind", "revision")


def audit_draw(run_id: str, task_id: str) -> float:
    """src/review.ts `auditDraw`, ported exactly: first 52 bits of sha256 over 2^52."""
    d = hashlib.sha256(f"{run_id}:{task_id}".encode()).digest()
    return (int.from_bytes(d[:8], "big") >> 12) / 2 ** 52


def run_id_from_log(path: str) -> str:
    """The run id, read off the arm's own log line: `fix <run_id>: N steps, ...`.

    Taken from the log rather than reconstructed from a timestamp because two runs on one afternoon
    can share a minute, and the wrong run directory is a failure that looks like a result.
    """
    if not os.path.exists(path):
        sys.exit(f"no log at {path} — has that arm run?")
    m = re.search(r"^fix (\S+?):", open(path).read(), re.M)
    if m is None:
        sys.exit(f"could not find the run id in {path}")
    return m.group(1)


def sandbox_result(sandbox: str, files: list[str]) -> dict[str, str]:
    """What an ungated arm left on disk: {relpath: contents}, the same shape `gate_survivors` returns.

    An ungated arm has no candidate JSON — its answer *is* the sandbox — so the contents are read back
    from there and then rendered by the same `render_diff` every other arm goes through.
    """
    out = {}
    for rel in files:
        p = os.path.join(sandbox, rel)
        if os.path.exists(p):
            out[rel] = open(p).read()
    return out


def gate_survivors(run_id: str) -> dict[str, dict[str, str]]:
    """task_id -> {relpath: resulting contents}, for everything that survived the gate in one run.

    **Contents, not the gate's own `.diff` file, and that is deliberate.** Every arm's diff in this
    pack is rendered by `render_diff` below, from file contents, by one code path. If arms A and B
    were rendered here and C and D were read from the gate's `diffs/` directory, any difference in
    how the two producers choose hunk context would be a **format tell** identifying the arm — the
    same §4.0 failure as a path in a header, one level less obvious.

    It also makes dedup correct. Arm D delivers arm A's changes, so the two must collapse to one item;
    two producers can emit different text for identical content, which would hash differently, split
    the item in two, and compute P(A) and P(D) from two independent judgements of the same change.
    """
    out: dict[str, dict[str, str]] = {}
    for vp in sorted(glob.glob(f".sidecrew/runs/{run_id}/verdicts/*.json")):
        v = json.load(open(vp))
        if not v.get("survived"):
            continue
        attempt = v["task_id"]                      # may carry a `#1` retry suffix
        base = attempt.split("#")[0]
        cp = f".sidecrew/runs/{run_id}/candidates/{attempt}.json"
        if not os.path.exists(cp):
            cp = f".sidecrew/runs/{run_id}/candidates/{attempt.replace('#', '.')}.json"
        if not os.path.exists(cp):
            print(f"  warn: survivor {attempt} has no candidate file — skipped")
            continue
        cand = json.load(open(cp))
        out[base] = {e["path"]: e["contents"] for e in cand["edits"]}
    return out


def render_diff(project_root: str, result: dict[str, str]) -> str:
    """The one diff renderer for every arm: project's own file vs the arm's resulting contents.

    Header rewritten to `--- a/<rel>` / `+++ b/<rel>`, and git's `diff --git`/`index` lines dropped, so
    nothing in the text says where the file came from. See `gate_survivors` for why one renderer.
    """
    out = []
    for rel in sorted(result):
        a = os.path.join(project_root, rel)
        if not os.path.exists(a):
            continue
        with tempfile.NamedTemporaryFile("w", suffix=os.path.basename(rel), delete=False) as tf:
            tf.write(result[rel])
            b = tf.name
        try:
            r = subprocess.run(["git", "diff", "--no-index", "--", a, b], capture_output=True, text=True)
        finally:
            os.unlink(b)
        for line in r.stdout.splitlines(keepends=True):
            if line.startswith(("diff --git ", "index ", "new file mode ", "old mode ", "new mode ")):
                continue
            if line.startswith("--- "):
                line = f"--- a/{rel}\n"
            elif line.startswith("+++ "):
                line = f"+++ b/{rel}\n"
            out.append(line)
    return "".join(out)


def draw(project: str) -> None:
    os.makedirs(PACKS, exist_ok=True)
    plan_path = f"{PLANS}/{project}-11b.json"
    plan = json.load(open(plan_path))
    project_root = plan["project"]          # absolute, into a client checkout — never printed
    tasks = [t for st in plan["steps"] for t in st["tasks"]]
    asks = {t["task_id"]: t["ask"] for t in tasks}
    # `PlannedChange.files` is a list of path strings (schemas.ts:579). The `{path, source, ...}`
    # shape belongs to `ChangeTask`, which is what a worker is handed after the plan is hydrated —
    # different type, same field name, and the plan is what is read here.
    files = {t["task_id"]: t["files"] for t in tasks}

    if not SCRATCH:
        sys.exit("set SIDECREW_11B_SCRATCH to the directory holding arm-a-<project>/ and arm-b-<project>/")

    # ── what each arm delivered, as resulting file contents ─────────────────────────────────────
    # Contents rather than diffs, so that every arm's diff is rendered by one code path below. See
    # `gate_survivors` for why that is a blindness requirement and not a refactor.
    results: dict[str, dict[str, dict[str, str]]] = {}   # arm -> task_id -> {relpath: contents}

    for arm, sub in (("A", f"arm-a-{project}"), ("B", f"arm-b-{project}")):
        sandbox = os.path.join(SCRATCH, sub)
        if not os.path.isdir(sandbox):
            print(f"arm {arm}: no sandbox at {sandbox} — skipping")
            continue
        # Everything produced, not a filtered subset: §4.1's asymmetry.
        results[arm] = {t["task_id"]: sandbox_result(sandbox, t["files"]) for t in tasks}

    for arm, log in (("C", f"{SQ}/results/arm-c-{project}.log"), ("D", f"{SQ}/results/arm-d-{project}.log")):
        if not os.path.exists(log):
            print(f"arm {arm}: no log yet — skipping")
            continue
        results[arm] = gate_survivors(run_id_from_log(log))

    # One renderer, one format, every arm.
    delivered: dict[str, dict[str, str]] = {}     # arm -> task_id -> diff text
    for arm, per_task in results.items():
        delivered[arm] = {}
        for task_id, contents in per_task.items():
            d = render_diff(project_root, contents)
            if d.strip():                          # an arm that changed nothing delivered nothing
                delivered[arm][task_id] = d

    # ── one item per distinct diff, attributed to every arm that delivered it ────────────────────
    by_text: dict[str, dict] = {}
    for arm, per_task in delivered.items():
        for task_id, diff in per_task.items():
            h = hashlib.sha256(diff.encode()).hexdigest()
            it = by_text.setdefault(h, {"diff": diff, "task_id": task_id, "arms": []})
            it["arms"].append(arm)
            if it["task_id"] != task_id:
                # Same text for two different tasks would break attribution; say so rather than guess.
                sys.exit(f"identical diff for {it['task_id']} and {task_id} — attribution is ambiguous")

    # Sampling, per §4.1's min(10, delivered) — applied per arm, on the arm's own draw, then unioned.
    # Union rather than intersection: an item sampled for any arm is reviewed, and it counts only
    # toward the arms that actually delivered it.
    keep: set[str] = set()
    for arm, per_task in delivered.items():
        run_key = arm
        ranked = sorted(per_task, key=lambda t: audit_draw(run_key, t))
        for task_id in ranked[: min(10, len(ranked))]:
            keep.add(hashlib.sha256(per_task[task_id].encode()).hexdigest())

    items = [dict(h=h, **v) for h, v in by_text.items() if h in keep]
    items.sort(key=lambda i: hashlib.sha256(i["diff"].encode()).hexdigest())

    key = {}
    with open(f"{PACKS}/{project}-pack.md", "w") as f:
        f.write(f"# Blind review pack — {project}\n\n")
        f.write("Each item is a change some configuration delivered. For each, answer **one** question:\n\n")
        f.write("> Would you have accepted this as the change that was asked for?\n\n")
        f.write("You are not told which configuration produced which diff, how many configurations\n")
        f.write("there are, or whether any diff was delivered by more than one. Do not try to infer it.\n")
        for i in items:
            oid = hashlib.sha256(("11b:" + i["h"]).encode()).hexdigest()[:10]
            base = i["task_id"].split("#")[0]
            body = f"\n---\n\n## {oid}\n\n**Ask:** {asks.get(base, '(unknown)')}\n\n"
            body += f"**Files:** {', '.join(files.get(base, []))}\n\n```diff\n{i['diff']}\n```\n"
            for bad in FORBIDDEN:
                assert bad not in body, f"{bad} leaked into the pack for {oid}"
            f.write(body)
            key[oid] = {"task_id": i["task_id"], "arms": sorted(i["arms"])}

    json.dump({"key": key, "denominators": {a: len(d) for a, d in delivered.items()}},
              open(f"{PACKS}/{project}-key.json", "w"), indent=2)
    print(f"delivered: " + ", ".join(f"{a}={len(d)}" for a, d in sorted(delivered.items())))
    print(f"distinct diffs: {len(by_text)}; reviewed: {len(items)}"
          f"  (saved {sum(len(d) for d in delivered.values()) - len(items)} duplicate readings)")
    print(f"pack  → {PACKS}/{project}-pack.md")
    print(f"key   → {PACKS}/{project}-key.json   (do not open until scoring)")


def score(project: str) -> None:
    blob = json.load(open(f"{PACKS}/{project}-key.json"))
    key, denoms = blob["key"], blob["denominators"]
    verdicts = json.load(open(f"{PACKS}/{project}-verdicts.json"))
    missing = set(key) - set(verdicts)
    if missing:
        sys.exit(f"{len(missing)} item(s) not reviewed: {sorted(missing)}")

    per_arm: dict[str, list[bool]] = {}
    for oid, accepted in verdicts.items():
        if oid not in key:
            sys.exit(f"verdict for unknown id {oid}")
        for arm in key[oid]["arms"]:
            per_arm.setdefault(arm, []).append(bool(accepted))

    print(f"P(x) — {project}; reviewed sample per arm, denominator is what that arm delivered\n")
    for arm, vs in sorted(per_arm.items()):
        n, k = len(vs), sum(vs)
        print(f"  arm {arm}: {k}/{n} = {k / n:.3f}   (delivered {denoms.get(arm, '?')})")
    print("\nP(A) vs P(D) is the thesis test: same judgements, two denominators, model held fixed.")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__.splitlines()[2].strip())
    mode, project = sys.argv[1], sys.argv[2]
    (draw if mode == "draw" else score)(project)
