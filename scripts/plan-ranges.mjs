#!/usr/bin/env node
// `line_range` and `source_sha` for the functions of one module, computed rather than typed.
//
//   node scripts/plan-ranges.mjs fixtures/ts-fixture/src/strings.ts truncate titleCase
//   node scripts/plan-ranges.mjs Sources/Mod/Strings.swift slugify --no-doc-comment
//
// These two fields are the plan's load-bearing pair: `source_sha` is what a run recomputes before it
// spends a token, and `line_range` is the mutation scope (ADR-0013). A hand-typed range that is one
// line out mutates something else and the verdict is about code nobody asked to test — so the planner
// does not type them, it runs this.
//
// The range starts at the doc comment by default. Comments carry no mutants, so the scope is unchanged,
// and `WorkerTask.function.source` is sliced from the same range — which means the worker is handed the
// sentence that states the contract instead of having to infer it from the body.
//
// The declaration and its extent come from `deriveLineRange` in the built package, deliberately, and not
// from a regex of this script's own (ADR-0035). They were two implementations of the same idea until the
// trial that found this: ADR-0033 taught `deriveLineRange` the eight shapes a real codebase uses and left
// the copy here matching `export function` alone, so the script the planner agent is told to run failed
// on 5 of 5 functions of a NestJS module with "has no function called X". One of them has to be the
// definition; this is the one with the tests.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let deriveLineRange;
try {
  ({ deriveLineRange } = await import(join(here, "..", "dist", "verifier", "shared.js")));
} catch {
  process.stderr.write("plan-ranges.mjs needs the built package: run `npm run build` first.\n");
  process.exit(2);
}

const [file, ...rest] = process.argv.slice(2);
const names = rest.filter((a) => !a.startsWith("--"));
const withDocComment = !rest.includes("--no-doc-comment");

if (!file || names.length === 0) {
  process.stderr.write("usage: plan-ranges.mjs <module> <function>… [--no-doc-comment]\n");
  process.exit(2);
}

const source = readFileSync(file, "utf8");
const lines = source.split("\n");
const swift = extname(file) === ".swift";

/** The first line of the run of `///` or `/** … *\/` lines immediately above `at` (1-based). */
function docCommentStart(at) {
  let first = at;
  for (let i = at - 1; i >= 1; i -= 1) {
    const line = (lines[i - 1] ?? "").trim();
    if (line === "") break;
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) first = i;
    else break;
  }
  return first;
}

const out = [];
for (const name of names) {
  const range = deriveLineRange(source, name, swift ? "swift" : "typescript");
  if (range === null) {
    process.stderr.write(`${file} has no function called ${name}\n`);
    process.exit(1);
  }
  const [declaredAt, to] = range;
  const from = withDocComment ? docCommentStart(declaredAt) : declaredAt;
  const slice = lines.slice(from - 1, to).join("\n");
  out.push({
    name,
    line_range: [from, to],
    source_sha: createHash("sha256").update(slice, "utf8").digest("hex"),
    declaration_at: declaredAt,
  });
}

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
