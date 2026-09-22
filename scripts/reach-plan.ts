// Phase 14c's declared task set — `S_big` and `S_small`, selected mechanically, in one plan
//
//   PATH=~/.nvm/versions/node/v22.23.2/bin:$PATH NODE_OPTIONS=--max-old-space-size=8192 \
//     npx tsx scripts/reach-plan.ts <project-dir> --refused experiments/reach/local/refused-project-a-2026-09-22.txt --n 20
//
// **The rule, written before it was run** (and copied into `experiments/reach/README.md` §3):
// the correction-round README §2 rule that picked Phase 14b's 30 tasks, applied once per arm, so that
// the two arms differ only in which side of the §1 clause their files are on.
//
// Pool, both arms: a non-test file under `src/`, in `tsc`'s program, with **1–3** errors under
// `--strictNullChecks` and **no TS2417/TS2418** (a base-class fix, outside any task by construction).
//
//   * `S_small` — the file is **not** in the refused list: one whole-file task, as 14b's were.
//   * `S_big`   — the file **is** in the refused list (its sha256 must match the committed census), and
//     every error lies inside a uniquely named declaration. Each error takes its **innermost** such
//     declaration, and the task names their union: no overlaps, and the union must pass the size clause.
//     One symbol task per file.
//
// Each arm is its first `n` files **by path**, an order unrelated to difficulty. The arms are
// **interleaved** in one step (big-01, small-01, big-02, …), so both see the same machine at the same
// hours; tasks in a step share one baseline, which is the "same run" §2 of the prompt demands. The gate
// settings are the plan defaults, written out so the result can quote them: `retry_regressions: true`,
// `demote_test_type_errors: true`, `compiler_flags: ["--strictNullChecks"]`.
//
// **Counts, never names.** The plan quotes client paths and goes under `experiments/reach/plans/`
// (gitignored). The committed summary carries pool sizes, exclusions by reason, and the plan's sha256.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { makeChangeSandbox, typecheck } from "../src/change.js";
import { isTestArtefact } from "../src/confinement.js";
import { MAX_FIX_TOKENS } from "../src/fix.js";
import { rewriteCost } from "../src/fix-validate.js";
import { declarations, type Span } from "../src/symbols.js";
import { removeSandbox } from "../src/verifier/shared.js";

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const project = resolve(args[0]!);
const refusedPath = flag("--refused")!;
const n = Number(flag("--n") ?? "20");
const today = new Date().toISOString().slice(0, 10);
const planOut = flag("--plan") ?? `experiments/reach/plans/project-a-${today}/change_plan.json`;
const summaryOut = flag("--out") ?? `experiments/reach/results/task-set-project-a-${today}.json`;
const FLAGS = ["--strictNullChecks"] as const;

const refusedText = readFileSync(refusedPath, "utf8");
const refused = new Set(refusedText.split("\n").filter(Boolean));
const refusedSha = createHash("sha256").update(refusedText, "utf8").digest("hex");

const ASK_WHOLE =
  "Fix every TypeScript error in this file that `tsc --strictNullChecks` reports, without changing what the " +
  "code does. Add the null or undefined checks the compiler now demands; do not change any behaviour that was " +
  "already correct, do not delete code to silence an error, and do not widen a type to `any`. Return the whole file.";
const ASK_SYMBOL =
  "Fix every TypeScript error in these declarations that `tsc --strictNullChecks` reports, without changing what " +
  "the code does. Add the null or undefined checks the compiler now demands; do not change any behaviour that was " +
  "already correct, do not delete code to silence an error, and do not widen a type to `any`. Return each declaration you change.";

const sandbox = await makeChangeSandbox(project);
let message = "";
let program = new Set<string>();
try {
  const run = await typecheck(sandbox, project, "tsconfig.json", 900_000, [...FLAGS]);
  message = run.message;
  program = run.program;
  console.error(`tsc --strictNullChecks: ${run.errors.total} errors in ${Object.keys(run.errors.by_file).length} files, ${Math.round(run.ms / 1000)} s`);
} finally {
  await removeSandbox(sandbox);
}

// path → [{ line, col, code }]
const errs = new Map<string, { line: number; col: number; code: string }[]>();
for (const raw of message.split("\n")) {
  const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/.exec(raw.trimEnd());
  if (!m) continue;
  const list = errs.get(m[1]!) ?? [];
  list.push({ line: Number(m[2]), col: Number(m[3]), code: m[4]! });
  errs.set(m[1]!, list);
}

const offsetOf = (source: string, line: number, col: number): number => {
  let at = 0;
  for (let l = 1; l < line; l += 1) at = source.indexOf("\n", at) + 1;
  return at + col - 1;
};

const excluded: Record<string, number> = {};
const drop = (why: string): void => { excluded[why] = (excluded[why] ?? 0) + 1; };
const big: { file: string; symbols: string[]; errors: number }[] = [];
const small: { file: string; errors: number }[] = [];

for (const file of [...errs.keys()].sort()) {
  const list = errs.get(file)!;
  if (!file.startsWith("src/") || isTestArtefact(file)) { drop("not source under src/"); continue; }
  if (!program.has(file)) { drop("not in program"); continue; }
  if (list.length > 3) { drop("more than 3 errors"); continue; }
  if (list.some((e) => e.code === "TS2417" || e.code === "TS2418")) { drop("TS2417/TS2418"); continue; }
  if (!refused.has(file)) { small.push({ file, errors: list.length }); continue; }

  const source = readFileSync(join(project, file), "utf8");
  const decls = declarations(source, file, project);
  if (decls === null) throw new Error("typescript is not resolvable from the project");
  const count = new Map<string, number>();
  for (const d of decls) count.set(d.name, (count.get(d.name) ?? 0) + 1);
  const unique = decls.filter((d) => count.get(d.name) === 1);
  const chosen = new Map<string, Span>();
  let ok = true;
  for (const e of list) {
    const at = offsetOf(source, e.line, e.col);
    const inner = unique.filter((d) => d.span.start <= at && at < d.span.end)
      .sort((a, b) => (a.span.end - a.span.start) - (b.span.end - b.span.start))[0];
    if (inner === undefined) { ok = false; break; }
    chosen.set(inner.name, inner.span);
  }
  if (!ok) { drop("big: an error outside every nameable declaration"); continue; }
  const spans = [...chosen.values()];
  if (spans.some((a) => spans.some((b) => a !== b && a.start < b.end && b.start < a.end))) { drop("big: named declarations overlap"); continue; }
  if (rewriteCost(spans.map((s) => source.slice(s.start, s.end))) > MAX_FIX_TOKENS) { drop("big: declarations too large to return"); continue; }
  big.push({ file, symbols: [...chosen.keys()], errors: list.length });
}

const pickBig = big.slice(0, n);
const pickSmall = small.slice(0, n);
const pad = (i: number): string => String(i + 1).padStart(2, "0");
const tasks: unknown[] = [];
for (let i = 0; i < Math.max(pickBig.length, pickSmall.length); i += 1) {
  const b = pickBig[i];
  const s = pickSmall[i];
  if (b) tasks.push({ task_id: `big-${pad(i)}`, ask: ASK_SYMBOL, files: [b.file], max_deleted_lines: 0, blocking: false, shape: "null_guard",
    symbols: b.symbols.map((name) => ({ file: b.file, name })) });
  if (s) tasks.push({ task_id: `small-${pad(i)}`, ask: ASK_WHOLE, files: [s.file], max_deleted_lines: 0, blocking: false, shape: "null_guard" });
}

const plan = {
  version: 1, language: "typescript", project, test_framework: "jest",
  meta: { planner_model: "mechanical-selection-no-planner", planner_tokens: 0, created: new Date().toISOString() },
  max_group_size: 10,
  correction: { enabled: false, max_corrections: 0, max_tokens: 0, on_observations: false },
  compiler_flags: [...FLAGS],
  retry_regressions: true,
  demote_test_type_errors: true,
  steps: [{ name: "14c: S_big and S_small, interleaved", tasks }],
};
const planText = `${JSON.stringify(plan, null, 2)}\n`;
mkdirSync(dirname(planOut), { recursive: true });
writeFileSync(planOut, planText, "utf8");

const summary = {
  measured: true,
  kind: "reach-task-set",
  phase: "14c",
  declared_at: new Date().toISOString(),
  rule: "experiments/reach/README.md §3",
  compiler_flags: FLAGS, retry_regressions: true, demote_test_type_errors: true, correction: false,
  refused_list_sha256: refusedSha,
  pool: { big: big.length, small: small.length },
  excluded,
  n_requested: n,
  selected: { big: pickBig.length, small: pickSmall.length,
    big_symbols: pickBig.reduce((k, b) => k + b.symbols.length, 0),
    big_errors: pickBig.reduce((k, b) => k + b.errors, 0), small_errors: pickSmall.reduce((k, s) => k + s.errors, 0) },
  plan_sha256: createHash("sha256").update(planText, "utf8").digest("hex"),
  project_commit: execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  project_dirty: execFileSync("git", ["-C", project, "status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
  sidecrew_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
};
mkdirSync(dirname(summaryOut), { recursive: true });
writeFileSync(summaryOut, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));
