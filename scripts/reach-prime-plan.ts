// Phase 14c′'s declared task set — 14c's 27 files, one declaration per task (prompt §1).
//
//   PATH=~/.nvm/versions/node/v22.23.2/bin:$PATH NODE_OPTIONS=--max-old-space-size=8192 \
//     npx tsx scripts/reach-prime-plan.ts <14c-plan.json> <pinned-clone-dir>
//
// The rule is `docs/plan/prompts/phase-14c-prime.md` §1, frozen before this ran. What it does, and
// nothing else: take exactly the files of 14c's declared plan, run `tsc --strictNullChecks` in a
// sandbox of the pinned clone, give each error its innermost uniquely nameable declaration (the
// `reach-plan.ts` rule, via `declarations`), and make one symbol task per declaration that carries an
// error, in both arms. Step k holds the k-th declaration of every file, in source order.
//
// Counts, never names (CLAUDE.md #7): the plan quotes client paths and lives under
// `experiments/reach/plans/` (gitignored); the committed summary carries counts and the plan's sha256.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { makeChangeSandbox, typecheck } from "../src/change.js";
import { declarations } from "../src/symbols.js";
import { removeSandbox } from "../src/verifier/shared.js";

const [planArg, cloneArg] = process.argv.slice(2);
if (planArg === undefined || cloneArg === undefined) {
  console.error("usage: reach-prime-plan.ts <14c-plan.json> <pinned-clone-dir>");
  process.exit(2);
}
const clone = resolve(cloneArg);
const today = new Date().toISOString().slice(0, 10);
const planOut = `experiments/reach/plans/project-a-${today}-prime/change_plan.json`;
const summaryOut = `experiments/reach/results/task-set-prime-project-a-${today}.json`;
const FLAGS = ["--strictNullChecks"] as const;

const planText14c = readFileSync(planArg, "utf8");
const plan14c = JSON.parse(planText14c) as { steps: { tasks: { task_id: string; files: string[] }[] }[] };
const files = plan14c.steps.flatMap((s) => s.tasks).map((t) => ({ arm: t.task_id.startsWith("big-") ? "big" : "small", file: t.files[0]! }));

const ASK =
  "Fix every TypeScript error in this declaration that `tsc --strictNullChecks` reports, without changing what " +
  "the code does. Add the null or undefined checks the compiler now demands; do not change any behaviour that was " +
  "already correct, do not delete code to silence an error, and do not widen a type to `any`. Return the declaration.";

const sandbox = await makeChangeSandbox(clone);
let message = "";
try {
  const run = await typecheck(sandbox, clone, "tsconfig.json", 900_000, [...FLAGS]);
  message = run.message;
  console.error(`tsc --strictNullChecks on the clone: ${run.errors.total} errors, ${Math.round(run.ms / 1000)} s`);
} finally {
  await removeSandbox(sandbox);
}

const errs = new Map<string, { line: number; col: number }[]>();
for (const raw of message.split("\n")) {
  const m = /^(.+?)\((\d+),(\d+)\): error TS\d+:/.exec(raw.trimEnd());
  if (!m) continue;
  errs.set(m[1]!, [...(errs.get(m[1]!) ?? []), { line: Number(m[2]), col: Number(m[3]) }]);
}
const offsetOf = (source: string, line: number, col: number): number => {
  let at = 0;
  for (let l = 1; l < line; l += 1) at = source.indexOf("\n", at) + 1;
  return at + col - 1;
};

interface Unit { arm: string; file: string; name: string; start: number; errors: number }
const perFile: Unit[][] = [];
let dropped = 0;
let errorsCovered = 0;
for (const { arm, file } of files) {
  const source = readFileSync(join(clone, file), "utf8");
  const decls = declarations(source, file, clone);
  if (decls === null) throw new Error("typescript is not resolvable from the clone");
  const count = new Map<string, number>();
  for (const d of decls) count.set(d.name, (count.get(d.name) ?? 0) + 1);
  const unique = decls.filter((d) => count.get(d.name) === 1);
  const units = new Map<string, Unit>();
  for (const e of errs.get(file) ?? []) {
    const at = offsetOf(source, e.line, e.col);
    const inner = unique.filter((d) => d.span.start <= at && at < d.span.end)
      .sort((a, b) => (a.span.end - a.span.start) - (b.span.end - b.span.start))[0];
    if (inner === undefined) { dropped += 1; continue; }
    errorsCovered += 1;
    const u = units.get(inner.name) ?? { arm, file, name: inner.name, start: inner.span.start, errors: 0 };
    u.errors += 1;
    units.set(inner.name, u);
  }
  perFile.push([...units.values()].sort((a, b) => a.start - b.start));
}

// Two declarations of one file can nest (a class, for an error in its body, and one of its methods).
// They never share a task or a step: each task names one declaration and step k takes one per file. A
// class too large to return is refused by the validator as `symbols_too_large_to_rewrite`, and counted
// then, before the first token (prompt §1).
const steps: { name: string; tasks: unknown[] }[] = [];
const depth = Math.max(0, ...perFile.map((u) => u.length));
const pad = (n: number): string => String(n).padStart(2, "0");
const armCount: Record<string, number> = { big: 0, small: 0 };
for (let k = 0; k < depth; k += 1) {
  const tasks: unknown[] = [];
  for (const units of perFile) {
    const u = units[k];
    if (u === undefined) continue;
    armCount[u.arm] = (armCount[u.arm] ?? 0) + 1;
    tasks.push({
      task_id: `${u.arm}-${pad(armCount[u.arm]!)}`, ask: ASK, files: [u.file], max_deleted_lines: 0, blocking: false,
      shape: "null_guard", symbols: [{ file: u.file, name: u.name }],
    });
  }
  steps.push({ name: `14c′ step ${k + 1}: the ${k + 1}${k === 0 ? "st" : k === 1 ? "nd" : k === 2 ? "rd" : "th"} declaration of each file`, tasks });
}

const plan = {
  version: 1, language: "typescript", project: clone, test_framework: "jest",
  meta: { planner_model: "mechanical-selection-no-planner", planner_tokens: 0, created: new Date().toISOString() },
  max_group_size: 10,
  correction: { enabled: false, max_corrections: 0, max_tokens: 0, on_observations: false },
  compiler_flags: [...FLAGS], retry_regressions: true, demote_test_type_errors: true, symbol_gate: "declaration",
  steps,
};
const text = `${JSON.stringify(plan, null, 2)}\n`;
mkdirSync(dirname(planOut), { recursive: true });
writeFileSync(planOut, text, "utf8");
const summary = {
  measured: true, kind: "reach-task-set-prime", phase: "14c′", declared_at: new Date().toISOString(),
  rule: "docs/plan/prompts/phase-14c-prime.md §1",
  from_plan_sha256: createHash("sha256").update(planText14c, "utf8").digest("hex"),
  files: { big: files.filter((f) => f.arm === "big").length, small: files.filter((f) => f.arm === "small").length },
  tasks: { big: armCount.big, small: armCount.small, total: (armCount.big ?? 0) + (armCount.small ?? 0) },
  steps: steps.length, errors_covered: errorsCovered, errors_dropped_outside_any_declaration: dropped,
  gate: { symbol_gate: "declaration", retry_regressions: true, demote_test_type_errors: true, compiler_flags: FLAGS, correction: false },
  plan_sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  project_commit: execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  project_dirty: execFileSync("git", ["-C", clone, "status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
  sidecrew_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
};
mkdirSync(dirname(summaryOut), { recursive: true });
writeFileSync(summaryOut, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));
