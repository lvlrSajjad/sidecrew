// ADR-0082 D's population, mechanically — `docs/plan/prompts/adr-0082-d.md` §1.
//
//   npx tsx scripts/d-population.ts <14c′-plan.json> <pinned-clone-dir>
//
// Reads files only (no compiler run, no tests), so it is safe beside a running measurement. For each of
// `big-01…10` and `small-01…10`, from 14c′'s declared plan: the module, the declaration, its line range
// and text from the AST, and where a candidate test for it would be written. The per-module exemplar is
// written afterwards by a Sonnet subagent (§4, decided B), which this gives the facts it needs.
//
// The output names client files and quotes nothing else; it goes to a gitignored directory
// (CLAUDE.md #7). Its sha256 is committed.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { testSuffixFor } from "../src/plan.js";
import { declarations, lineAt, resolveSymbol } from "../src/symbols.js";
import { testDirFor } from "../src/verifier/shared.js";

const [planArg, cloneArg] = process.argv.slice(2);
const clone = resolve(cloneArg!);
const plan = JSON.parse(readFileSync(planArg!, "utf8")) as { steps: { tasks: { task_id: string; files: string[]; symbols: { file: string; name: string }[] }[] }[] };
const wanted = [...Array.from({ length: 10 }, (_, i) => `big-${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 10 }, (_, i) => `small-${String(i + 1).padStart(2, "0")}`)];
const byId = new Map(plan.steps.flatMap((s) => s.tasks).map((t) => [t.task_id, t]));

const testDir = testDirFor(clone);
const suffix = testSuffixFor(clone);
const rows = wanted.map((id) => {
  const t = byId.get(id);
  if (t === undefined) throw new Error(`${id} is not in the 14c′ plan`);
  const { file, name } = t.symbols[0]!;
  const source = readFileSync(join(clone, file), "utf8");
  const r = resolveSymbol(source, name, file, clone);
  if (!r.ok) throw new Error(`${id}: ${name} does not resolve (${r.reason})`);
  const text = source.slice(r.span.start, r.span.end);
  return {
    task_id: id, arm: id.split("-")[0], module: file, symbol: name,
    // Workload #1 names a function by its own name; the line range is what makes a class member exact.
    function_name: name.includes(".") ? name.slice(name.indexOf(".") + 1) : name,
    line_range: [lineAt(source, r.span.start), lineAt(source, r.span.end - 1)],
    source_sha: createHash("sha256").update(text, "utf8").digest("hex"),
  };
});

// Per module: the declarations a planner may use for the exemplar — anything nameable and **not** in the
// sample, because an exemplar about the function under test would hand the worker the answer (ADR-0015).
const modules = [...new Set(rows.map((r) => r.module))].map((module) => {
  const source = readFileSync(join(clone, module), "utf8");
  const sampled = new Set(rows.filter((r) => r.module === module).map((r) => r.symbol));
  const others = (declarations(source, module, clone) ?? [])
    .filter((d) => !sampled.has(d.name) && d.name.includes("."))
    .map((d) => d.name);
  return { module, lines: source.split("\n").length, exemplar_candidates: others };
});

const out = { clone_commit_pinned: "1d79d903f9", test_dir: testDir, test_suffix: suffix, rows, modules };
const text = `${JSON.stringify(out, null, 2)}\n`;
const path = "experiments/test-first/local/d-population.json";
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, text, "utf8");
console.log(JSON.stringify({
  declarations: rows.length, modules: modules.length, test_dir: testDir, test_suffix: suffix,
  modules_without_exemplar_candidates: modules.filter((m) => m.exemplar_candidates.length === 0).length,
  sha256: createHash("sha256").update(text, "utf8").digest("hex"),
}, null, 2));
