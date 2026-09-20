// Phase 14b probe 2 — narrow each of §2.2's 30 asks to the single function that carries the error.
//
//   npx tsx scripts/editing-ceiling-decompose.ts <plan.json> <pass1-run-dir> <out-plan.json>
//
// **What this does and does not change.** The task set is the same 30 tasks, the same files, the same
// gate and the same `shape: "null_guard"`. The only thing that moves is the `ask`: instead of "fix
// every error in this file", it names the enclosing function and its line range. The return format is
// still the whole file (ADR-0047 §2) because symbol-scoped return is ADR-0075's and is undecided.
//
// So probe 2 varies **reasoning scope** while probe 1 varies the **model**, and each changes exactly
// one thing from pass 1. `experiments/editing-ceiling/README.md` §3 states the consequence in the
// direction that matters: a low `S₁₄` here rules out ask-narrowing as the lever and does NOT rule out
// a genuinely symbol-scoped task of the kind 14c would make possible.
//
// The enclosing function comes from the TypeScript AST rather than a scanner. ADR-0076 measured the
// scanner missing 152 of 436 declarations in our own `src` and getting 5 wrong, every one by cutting a
// body short — and a truncated range here would silently narrow the ask to the wrong lines, which is a
// wrong number rather than a crash.
import { readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import ts from "typescript";

const [planPath, runDir, outPath] = process.argv.slice(2);
if (planPath === undefined || runDir === undefined || outPath === undefined) {
  process.stderr.write("usage: editing-ceiling-decompose.ts <plan.json> <pass1-run-dir> <out-plan.json>\n");
  process.exit(1);
}
const say = (s: string): void => { process.stdout.write(`${s}\n`); };

interface Enclosing { name: string; start: number; end: number; kind: string }

/**
 * The innermost function-like declaration containing `line` (1-based), or null.
 *
 * Innermost rather than outermost: a guard belongs in the callback that dereferences the value, not in
 * the method that happens to contain the callback, and naming the outer one would widen the ask back
 * out to roughly the whole file on exactly the large tasks this probe is about.
 */
const enclosingOf = (source: string, file: string, line: number): Enclosing | null => {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const target = line - 1;
  let best: Enclosing | null = null;
  const visit = (node: ts.Node): void => {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
    if (target < start || target > end) return;          // the line is not in this subtree
    if (
      ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) || ts.isConstructorDeclaration(node) ||
      ts.isGetAccessor(node) || ts.isSetAccessor(node)
    ) {
      // A named parent is what a human would call this thing: an arrow assigned to `const foo` is
      // "foo", not "<anonymous>". Fall back to the property/variable it is bound to.
      let name = "(anonymous)";
      if ("name" in node && node.name !== undefined && ts.isIdentifier(node.name as ts.Node)) {
        name = (node.name as ts.Identifier).text;
      } else {
        const p = node.parent;
        if ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p)) &&
            ts.isIdentifier(p.name)) name = p.name.text;
      }
      best = { name, start: start + 1, end: end + 1, kind: ts.SyntaxKind[node.kind] };
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return best;
};

const plan = JSON.parse(await readFile(planPath, "utf8")) as {
  project: string;
  steps: { tasks: { task_id: string; ask: string; files: string[]; notes: string | null }[] }[];
};

const out = structuredClone(plan);
let single = 0, multi = 0, unresolved = 0;

for (const [s, step] of plan.steps.entries()) {
  for (const [i, task] of step.tasks.entries()) {
    const file = task.files[0]!;
    const source = await readFile(join(plan.project, file), "utf8");
    // The diagnostics the worker was shown in pass 1, which are the ones the verdict is scored against.
    const t = JSON.parse(await readFile(join(runDir, "tasks", `${task.task_id}.json`), "utf8")) as { diagnostics: string };
    const lines = [...new Set(
      t.diagnostics.split("\n")
        .map((l) => /\((\d+),\d+\): error/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1])),
    )];

    const fns = new Map<string, Enclosing>();
    for (const line of lines) {
      const e = enclosingOf(source, file, line);
      if (e !== null) fns.set(`${e.name}:${e.start}`, e);
    }

    const target = out.steps[s]!.tasks[i]!;
    if (fns.size === 0) {
      // Top-level code, a decorator, a property initialiser — there is no enclosing function to name.
      // The ask is left exactly as pass 1 had it, and the count is reported: a probe that quietly fell
      // back to the whole file on a third of the set would be measuring pass 1 again.
      unresolved++;
      target.notes = `${task.notes ?? ""} [probe 2: no enclosing function — the error is not inside one, so this ask is unchanged from pass 1]`.trim();
      continue;
    }
    if (fns.size === 1) single++; else multi++;

    const list = [...fns.values()].sort((a, b) => a.start - b.start);
    const where = list.map((f) => `\`${f.name}\` (lines ${f.start}–${f.end})`).join(" and ");
    const n = lines.length;

    target.ask =
      `In this file, ${list.length === 1 ? "one function has" : "these functions have"} ` +
      `${n} TypeScript error${n === 1 ? "" : "s"} under \`tsc --strictNullChecks\`: ${where}. ` +
      `Change only ${list.length === 1 ? "that function" : "those functions"} — every other line of the ` +
      `file must come back exactly as it is now.\n\n` +
      `Add the null or undefined checks the compiler demands on the reported line${n === 1 ? "" : "s"}. ` +
      `Do not change what the code does, do not delete code to silence an error, and do not widen a ` +
      `type to \`any\`. Return the whole file, with your change in it.`;
    target.notes =
      `${task.notes ?? ""} [probe 2: ask narrowed to ${list.length} function(s), ` +
      `${list.map((f) => `${f.end - f.start + 1} lines`).join(" + ")}, from a ${source.split("\n").length}-line file]`.trim();
  }
}

await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
say(`${basename(outPath)}: ${single} single-function, ${multi} multi-function, ${unresolved} unresolved`);
say(unresolved === 0
  ? "  every task narrowed — probe 2 varies scope on all 30"
  : `  ${unresolved} task(s) keep pass 1's whole-file ask; they are NOT decomposed and the result says so`);
