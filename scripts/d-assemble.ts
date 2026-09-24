// ADR-0082 D: turn the planner's per-module choices into workload #1 `TestPlan`s — mechanically.
//
//   npx tsx scripts/d-assemble.ts <pinned-clone-dir> [--planner-tokens N]
//
// The Sonnet planner (§4, decided B) wrote one exemplar and one `choice.json` per module under
// `experiments/test-first/plans/mNN/`. Everything a planner could get subtly wrong is **not** taken
// from it: the line range comes from `d-population.json` (the AST), and `source_sha` is recomputed
// here with the project's own `sliceLines` and `sourceSha`, because that is the definition `validate`
// checks against. A hash of the declaration's exact span would differ from it by the indentation and
// read as a stale plan.
//
// Reads and writes files only. Plans stay under the gitignored `experiments/test-first/plans/`.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TestPlan } from "../src/schemas.js";
import { sliceLines, sourceSha } from "../src/plan.js";

const args = process.argv.slice(2);
const clone = resolve(args[0]!);
const tokensAt = args.indexOf("--planner-tokens");
const plannerTokens = tokensAt >= 0 ? Number(args[tokensAt + 1]) : 0;
const root = "experiments/test-first/plans";
const pop = JSON.parse(readFileSync("experiments/test-first/local/d-population.json", "utf8")) as {
  rows: { task_id: string; module: string; symbol: string; function_name: string; line_range: [number, number] }[];
};

// The shape's rule, word for word from `docs/specs/pipeline.md` § Shapes, so it is the one every
// workload #1 number was taken with.
const HAPPY = "One or two representative inputs; assert the exact return value, never its type or its length.";

let written = 0;
const problems: string[] = [];
for (const dir of readdirSync(root).filter((d) => /^m\d\d$/.test(d)).sort()) {
  const choicePath = join(root, dir, "choice.json");
  if (!existsSync(choicePath) || !existsSync(join(root, dir, "exemplars", "happy_path.spec.ts"))) {
    problems.push(`${dir}: no choice.json or exemplar`);
    continue;
  }
  const choice = JSON.parse(readFileSync(choicePath, "utf8")) as {
    module: string; exemplar_function: string; sampled: { symbol: string; signature: string; notes: string }[];
  };
  const rows = pop.rows.filter((r) => r.module === choice.module);
  if (rows.length === 0) { problems.push(`${dir}: its module is not in the population`); continue; }
  const source = readFileSync(join(clone, choice.module), "utf8");
  const plan = {
    version: 1, language: "typescript", module: join(clone, choice.module), test_framework: "jest",
    meta: { planner_model: "claude-sonnet-5 (subagent, ADR-0082 D §4 option B)", planner_tokens: plannerTokens, created: new Date().toISOString() },
    shapes: [{ kind: "happy_path", exemplar: "exemplars/happy_path.spec.ts", exemplar_function: choice.exemplar_function, rules: HAPPY }],
    functions: rows.map((r) => {
      const said = choice.sampled.find((s) => s.symbol === r.symbol);
      return {
        name: r.function_name,
        signature: said?.signature ?? r.function_name,
        source_sha: sourceSha(sliceLines(source, r.line_range)),
        line_range: r.line_range,
        shapes: ["happy_path"],
        ...(said?.notes ? { notes: said.notes } : {}),
      };
    }),
  };
  const parsed = TestPlan.safeParse(plan);
  if (!parsed.success) { problems.push(`${dir}: ${parsed.error.issues.map((i) => i.message).join("; ")}`); continue; }
  writeFileSync(join(root, dir, "test_plan.json"), `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
  written += 1;
}
console.log(JSON.stringify({ plans_written: written, problems }, null, 2));
