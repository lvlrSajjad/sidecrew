# Phase 14c′ — a big change is not a big file

Inserted by 14c's frozen rule (ADR-0087). **§2 and §3 are the frozen part, written 23 Sep 2026 before
the task set was decomposed and before any number existed.** Amend below them, dated, never in place.

## 0. The question, in one paragraph

14c showed that the file's size stopped mattering: the worker clears the same share of a task's errors
inside a 4,000-line service as in a small file (0.304 vs 0.307). It also showed that both arms fail on
**the size of the change**: handed 2–8 errors at once, the worker clears about a third. So hand it
**one declaration at a time**, judged by that declaration (ADR-0086 §6 option B, decided 23 Sep), and
ask whether the reached code can now be changed at a usable rate, and whether a declaration inside a
big file does as well as one inside a small file.

## 1. The task set — the same 27 files, decomposed mechanically

- **Files:** exactly the 27 of 14c's declared task set (plan sha256 `8a228fd7…`), 9 big and 18 small, at
  project-a `1d79d903f9`. **Run on a clone at that commit** (ADR-0088 addendum), never the working
  checkout, which has moved since.
- **Unit:** each `--strictNullChecks` error at the baseline takes its **innermost uniquely nameable
  declaration** (the `reach-plan.ts` rule). One task per declaration carrying at least one error,
  **in both arms**: a small file's declarations are symbol tasks too, so the arms differ only in file
  size. An error inside no nameable declaration is dropped and counted.
- **Order:** within a file, declarations in source order. Step *k* holds the *k*-th declaration of every
  file, so each file's tasks run in sequence on the project its earlier survivors left behind
  (ADR-0044 §2), and no step lists a file twice.
- **Gate:** `symbol_gate: "declaration"`, `retry_regressions: true`, `demote_test_type_errors: true`,
  `compiler_flags: ["--strictNullChecks"]`, correction off. The worker is the 7B at 2.
- **Validated before the first token.** A task the validator refuses is removed then and counted by
  code. Nothing is added, dropped or re-planned after the first token.

## 2. The measures — frozen

- `S′_big` = surviving tasks / tasks, over declarations in the 9 big files; `S′_small` the same over the
  18 small files. **Each is `k/n` with an exact Clopper–Pearson 95 % interval** (`results-11b.py`), and
  the report says whether the two intervals overlap.
- **The safety check on B, which overrides the fork.** After the run, every survivor is applied
  together (`runFix` already does). If that combined state shows **any regression in the suite** or
  **more `tsc` errors than the start in any of the 27 files**, then B passed something it should not
  have: **STOP**, whatever the rates say, and fix the gate before anything else.

## 3. The fork — frozen

| | |
|---|---|
| `S′_big ≥ 0.30` **and** `S′_big ≥ 0.75 × S′_small` | **PROCEED to 14d.** The reached code is changed at a usable rate, and big files are not worse. Cutting `v0.2.0` becomes the owner's call again, with a recommendation to cut |
| `S′_big ≥ 0.75 × S′_small` **but** `S′_big < 0.30` | **PROCEED to 14d**, with the shape recorded as *improvable, not usable*. `v0.2.0` stays held. ADR-0087 C (sibling signatures in the symbol prompt) is the next lever, as a probe |
| `S′_big < 0.75 × S′_small` | **INSERT 14c″ = ADR-0087 C.** At equal change size, a declaration inside a big file does worse, so what the prompt leaves out of a big file (its siblings) is the suspect |
| `S′_small = 0` | **UNDEFINED.** The ratio is meaningless; report the rates and decide nothing from them |

**0.30 is 14b's line between "improvable" and "usable"**, reused rather than invented. At the plan sizes
this will use, the intervals will overlap: **a ratio between overlapping intervals is a direction, and
it is reported as one.**

## 4. How to run it without poisoning the number

Everything in 14c's `prompts/phase-14c-the-reach.md` §4 applies: a quiet machine, no swapping, do not
span **02:00 local** (ADR-0083), clean trees, and record both commits. In addition:

- **The owner says when it runs.** It is prepared and dry-run, and it waits.
- **The clone's integrity is checked, and so is the working checkout's** (ADR-0088): both fingerprints
  go in the result.
