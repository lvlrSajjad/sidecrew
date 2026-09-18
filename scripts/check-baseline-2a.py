#!/usr/bin/env python3
"""Did this run's baseline match the quiet-machine reference? Exit 0 if yes, 1 if the run must be redone.

    scripts/check-baseline-2a.py <config> <input>

The protocol note in experiments/go-no-go-2a/README.md has the argument: workload #2a's baseline and
its candidates' suite runs are separated in time, so a baseline captured under load silently *weakens*
the gate — only the tests that survived the contention have to keep passing. A rate taken against it
would be an overstatement and nothing in the verdict would say so. So the baseline is checked against
a reference measured twice on an idle machine, and a run that does not match is discarded, never
repaired.
"""
import glob, json, os, sys

config, input_id = sys.argv[1], sys.argv[2]
SP = "experiments/go-no-go-2a"
# The reference is keyed by the anonymous names (CLAUDE.md #7), not by the client's repository
# names. Keeping the old keys here is how a rename in one file silently failed a good arm.
PROJECTS = {"api": "project-a", "web": "project-b", "fixture": None}

partial_path = f"{SP}/results/partials/{config}-{input_id}.json"
if not os.path.exists(partial_path):
    print(f"FAIL  no partial at {partial_path} — the run did not finish")
    sys.exit(1)

partial = json.load(open(partial_path))
name = PROJECTS[input_id]
if name is None:
    print("SKIP  the fixture has no reference row; its suite is 12 tests and runs in under a second")
    sys.exit(0)

refs = json.load(open(f"{SP}/results/baseline-reference.json"))["projects"]
if name not in refs:
    print(f"FAIL  no reference row for {name}; rows are {sorted(refs)} — this is a harness bug, not a bad baseline")
    sys.exit(1)
ref = refs[name]
# The partial is committed, so its `run_id` is redacted (CLAUDE.md #7) — while the run directory
# under .sidecrew/ is gitignored and still carries the project's real name. Match on the timestamp,
# which is unique per run and identifies nobody.
run_id = partial["result"]["run_id"]
stamp = run_id.split("-" + PROJECTS[input_id], 1)[0] if PROJECTS[input_id] else run_id
candidates = sorted(glob.glob(f".sidecrew/runs/{stamp}*"))
if len(candidates) != 1:
    print(f"FAIL  expected exactly one run directory for {stamp}, found {len(candidates)}: {candidates}")
    sys.exit(1)
bpath = f"{candidates[0]}/baselines/0.json"
if not os.path.exists(bpath):
    print(f"FAIL  no baseline at {bpath}")
    sys.exit(1)

b = json.load(open(bpath))
ran, passed = b["tests"]["ran"], b["tests"]["passed"]
want_ran, want_passed = ref["tests_ran"], ref["tests_passed"]
errs_got, errs_want = b["errors"]["total"], ref["tsc_errors"]

# What this is for, and therefore how tight it should be.
#
# It exists to catch **gross** contamination — ADR-0052 cost 3,739 of 6,156 passing tests, a 61 % loss
# — and not to police a real suite's ordinary flakiness. A real project's suite is not a pure
# function: project-a returned 6156 passing three times and then 6159, three tests that are timing- or
# order-sensitive. An exact-match rule fails that good run, reports "baseline did not match the
# reference" — which is the one sentence that means *discard* — and spends ninety minutes of retry
# saying nothing. A guard whose failure mode is indistinguishable from the failure it guards against
# is worse than no guard.
#
# So: `ran` must match exactly, because the number of tests *collected* is a property of the code and
# a change there means the project moved (re-measure, do not compare). `passed` gets a 1 % band —
# 64 tests on project-a — which is two orders of magnitude tighter than the contamination it has to
# catch and far looser than any flakiness observed.
TOLERANCE = 0.01
slack = max(1, round(want_passed * TOLERANCE))
ran_ok = ran == want_ran
passed_ok = abs(passed - want_passed) <= slack
errs_ok = errs_got == errs_want

ok = ran_ok and passed_ok and errs_ok
print(f"{'OK  ' if ok else 'FAIL'}  {config}-{input_id}  run {run_id}")
print(f"      tests ran:    got {ran}, reference {want_ran} {'ok' if ran_ok else 'MISMATCH — the project moved; re-measure the reference'}")
print(f"      tests passed: got {passed}, reference {want_passed} (±{slack}) {'ok' if passed_ok else 'OUTSIDE THE BAND'}")
print(f"      tsc errors:   got {errs_got}, reference {errs_want} {'ok' if errs_ok else 'MISMATCH'}")
if not ok:
    print("      → this run is DISCARDED, not repaired (README protocol note)")
sys.exit(0 if ok else 1)
