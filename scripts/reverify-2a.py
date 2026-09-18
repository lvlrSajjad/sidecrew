#!/usr/bin/env python3
"""§4.0 bullet 3: re-verify one survivor from scratch, from its recorded diff.

    scripts/reverify-2a.py <project-dir> <run-dir> <task-id> <jest|vitest> [extra-PATH]

Deliberately **not** sidecrew's verifier. The point of the precondition is that the gate can be checked
by something that does not share its code: this applies the recorded unified diff to a fresh copy of the
project with `patch`, runs the project's own `tsc` and its own suite, and prints the three facts the
verdict claims. If sidecrew's gate and this disagree, the run is void — ADR-0037 is why that sentence is
in the protocol at all.
"""
import json, os, re, shutil, subprocess, sys, tempfile

proj, run_dir, task, runner = sys.argv[1:5]
extra_path = sys.argv[5] if len(sys.argv) > 5 else None
env = dict(os.environ)
if extra_path:
    env["PATH"] = extra_path + os.pathsep + env["PATH"]
env["NODE_OPTIONS"] = env.get("NODE_OPTIONS", "") + " --max-old-space-size=8192"

diff = os.path.join(run_dir, "diffs", f"{task}.diff")
if not os.path.isfile(diff):
    sys.exit(f"no diff at {diff}")

proj = os.path.abspath(proj)
sb = tempfile.mkdtemp(prefix="reverify-")
print(f"project : {proj}\ndiff    : {diff}\nsandbox : {sb}\n")

SKIP = {"node_modules", ".git", "dist", "build", "coverage", ".next", ".sidecrew"}
shutil.copytree(proj, sb, dirs_exist_ok=True,
                ignore=lambda d, names: [n for n in names if n in SKIP])
os.symlink(os.path.join(proj, "node_modules"), os.path.join(sb, "node_modules"))

ERR = re.compile(r"error TS\d+")

def tsc():
    r = subprocess.run([f"{sb}/node_modules/.bin/tsc", "--noEmit", "-p", "tsconfig.json"],
                       cwd=sb, capture_output=True, text=True, env=env)
    out = r.stdout + r.stderr
    return len(ERR.findall(out)), out

def suite(tag):
    path = os.path.join(sb, f"{tag}.tests.json")
    args = (["--ci", "--json", f"--outputFile={path}"] if runner == "jest"
            else ["run", "--reporter=json", f"--outputFile={path}"])
    r = subprocess.run([f"{sb}/node_modules/.bin/{runner}", *args],
                       cwd=sb, capture_output=True, text=True, env=env)
    try:
        return json.load(open(path)), None
    except Exception as e:
        return None, f"{e}\n{(r.stdout + r.stderr)[-1500:]}"

def passing(rep):
    out = set()
    for s in rep.get("testResults", []):
        for t in s.get("assertionResults", []):
            if t.get("status") == "passed":
                out.add(f"{s.get('name','')}::{t.get('fullName') or t.get('title','')}")
    return out

print("── before ─────────────────────────────────────────")
be, btxt = tsc()
brep, berr = suite("before")
if brep is None:
    sys.exit(f"the baseline suite produced no report:\n{berr}")
print(f"tsc errors: {be}    tests: {brep['numPassedTests']}/{brep['numTotalTests']} passing")

print("\n── applying the recorded diff ─────────────────────")
p = subprocess.run(["patch", "-p1", "--no-backup-if-mismatch", "-i", diff],
                   cwd=sb, capture_output=True, text=True)
print((p.stdout + p.stderr).strip())
if p.returncode != 0:
    sys.exit("PATCH FAILED")

print("\n── after ──────────────────────────────────────────")
ae, atxt = tsc()
arep, aerr = suite("after")
if arep is None:
    sys.exit(f"the post-change suite produced no report:\n{aerr}")
print(f"tsc errors: {ae}    tests: {arep['numPassedTests']}/{arep['numTotalTests']} passing")

print("\n── the three claims ───────────────────────────────")
regressed = sorted(passing(brep) - passing(arep))
ran_ok = arep["numTotalTests"] >= brep["numTotalTests"] > 0
compile_ok = ae <= be
print(f"compile_ok : errors {be} -> {ae}   (none introduced: {compile_ok})")
print(f"tests_ok   : ran {brep['numTotalTests']} -> {arep['numTotalTests']} (>= and > 0: {ran_ok}); regressed: {len(regressed)}")
for r in regressed[:10]:
    print(f"             REGRESSED {r}")
print(f"\nindependent verdict: {'SURVIVED' if compile_ok and ran_ok and not regressed else 'DID NOT SURVIVE'}")
shutil.rmtree(sb, ignore_errors=True)
