// What both verifiers need and neither owns. Extracted in Phase 3 rather than copied: `truncateError`
// and the brace matcher are the same code in TypeScript and in Swift, and the one thing that must never
// differ between two verifiers is the shape of what they return.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { RunResult } from "../exec.js";
import { MAX_ERROR_CHARS } from "../schemas.js";
import { mask, type Dialect } from "./tautology.js";

/**
 * The runners this verifier can drive, which is a narrower set than `TestFramework` allows on purpose.
 *
 * `TestFramework` is an open string because the contract must not refuse a project before the verifier
 * has said whether it can handle it (see `schemas.ts`). This is the verifier saying so: two runners, and
 * anything else gets a `VerifierSetupError` naming both rather than a vitest command that fails
 * confusingly three stages later.
 */
export type TestRunner = "vitest" | "jest";

export const TEST_RUNNERS: readonly TestRunner[] = ["vitest", "jest"];

export const isTestRunner = (value: string): value is TestRunner =>
  (TEST_RUNNERS as readonly string[]).includes(value);

/** Stryker drives a runner through a plugin package, and it must be installed in the target project. */
export const STRYKER_PLUGIN: Record<TestRunner, string> = {
  vitest: "@stryker-mutator/vitest-runner",
  jest: "@stryker-mutator/jest-runner",
};

/**
 * Where a project's `node_modules` actually is, which is not always inside the project (ADR-0029).
 *
 * npm, yarn and pnpm workspaces **hoist**: a package in `packages/shared` has its dependencies installed
 * at the repo root, and `packages/shared/node_modules` may not exist at all. Node resolves from the
 * workspace perfectly well — it walks up, which is what this does. Checking the path instead reports
 * every dependency of every workspace package as missing, which is what sidecrew did, on the first real
 * monorepo it was pointed at.
 */
export function resolveNodeModules(projectDir: string): string | null {
  let dir = resolve(projectDir);
  for (;;) {
    const candidate = join(dir, "node_modules");
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Is `pkg` installed and resolvable *from* `projectDir`? Resolution, not a path check.
 *
 * `require.resolve` with `paths` asks Node the same question Node will ask at runtime, so it is right in
 * a hoisted workspace, right with a symlinked package, and right for a dependency of a dependency.
 */
export function isResolvable(pkg: string, projectDir: string): boolean {
  try {
    createRequire(join(resolve(projectDir), "package.json")).resolve(`${pkg}/package.json`);
    return true;
  } catch {
    // Not every package exports its own package.json. Fall back to the entry point.
    try {
      createRequire(join(resolve(projectDir), "package.json")).resolve(pkg);
      return true;
    } catch {
      return false;
    }
  }
}

/** The machine cannot run the verifier at all. Not a failed candidate — do not retry, fix the setup. */
export class VerifierSetupError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "VerifierSetupError";
  }
}

// Written as an escape rather than as the raw ESC byte Phase 2 had: a control character in source is
// invisible in a diff, and a reviewer cannot check what they cannot see.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * What the single retry gets to read. Head-first and capped at the contract's 2 KB: a compiler says
 * what is wrong in its first lines and then repeats itself, and the whole of a mutation log is not
 * something a 7B model is going to use. Callers put the most actionable sentence first for the same
 * reason — under the cap, order is priority.
 */
export function truncateError(text: string): string {
  const clean = text.replace(ANSI, "").trim();
  if (clean.length <= MAX_ERROR_CHARS) return clean;
  const marker = `\n… truncated at ${MAX_ERROR_CHARS} characters`;
  return clean.slice(0, MAX_ERROR_CHARS - marker.length) + marker;
}

/**
 * Did this stage die because node ran out of heap, rather than because the candidate was wrong?
 *
 * Measured on a 576,606-line project (ADR-0032): `tsc --noEmit` needs more than node's default ~4 GB and
 * dies at ~52 s, every candidate, on a machine with 13 GB free. The project's own script says so —
 * `NODE_OPTIONS=--max-old-space-size=8192 tsc --noEmit` — and sidecrew has no way to know that.
 *
 * Left alone it is the worst kind of failure this project has: `compile_ok: false` with a compiler error
 * attached, which reads exactly like a candidate that does not compile, twice per task because the retry
 * rule spends an attempt on it.
 */
export const looksLikeOom = (text: string): boolean =>
  /JavaScript heap out of memory|Reached heap limit|Ineffective mark-compacts near heap limit/.test(text);

/** Both streams, or the timeout that stopped them. */
export const output = (r: RunResult): string =>
  r.timedOut ? `timed out after ${r.ms} ms\n${r.stdout}\n${r.stderr}` : `${r.stdout}\n${r.stderr}`;

/** A task_id is worker-supplied and ends up as a filename. This is the part of it that may. */
export const safeName = (taskId: string): string =>
  taskId.replace(/[^\w.-]+/g, ".").replace(/^\.+|\.+$/g, "") || "candidate";

/** How each dialect spells "here begins the function called `name`". */
/**
 * How each dialect can spell "here begins the function called `name`" — all of the ways, not one (ADR-0033).
 *
 * TypeScript had exactly one: a top-level `export function`. Measured on a real NestJS codebase, that is
 * **23 of ~1,504 functions — 1.5 %**. The idiom there, and in most of the framework world, is a class of
 * static methods; the same file's other 1,429 declarations were invisible, and so every plan had to carry
 * its line ranges by hand and the probe could not run at all.
 *
 * The alternatives are ordered most-specific first, because `foo(` as a class method is the loosest
 * pattern here and would otherwise match a *call* to `foo(` on a line of its own.
 */
const TS_DECLARATIONS = (name: string): RegExp[] => [
  // export function foo(…)  /  export async function foo(…)
  new RegExp(`^[ \\t]*export\\s+(?:async\\s+)?function\\s+${name}\\b`, "m"),
  // function foo(…) — not exported, but reachable when the module's default export re-exposes it
  new RegExp(`^[ \\t]*(?:async\\s+)?function\\s+${name}\\b`, "m"),
  // export const foo = (…) => / = async (…) => / = function (…)
  new RegExp(`^[ \\t]*export\\s+(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function\\b|\\(|<)`, "m"),
  // static foo = (…) =>  /  public static readonly foo = (…) =>   — a class property holding a function
  new RegExp(`^[ \\t]*(?:(?:public|private|protected|static|readonly|abstract|override)\\s+)*${name}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function\\b|\\(|<)`, "m"),
  // static foo(…) / public static async foo(…) / foo(…) — a class method. Loosest, so it is last, and it
  // demands a modifier or an `async` unless the line is unmistakably a declaration followed by a body.
  new RegExp(`^[ \\t]*(?:(?:public|private|protected|static|readonly|abstract|override|async)\\s+)+${name}\\s*[(<]`, "m"),
  new RegExp(`^[ \\t]*${name}\\s*\\([^)]*\\)\\s*(?::[^{;=]+)?\\s*\\{`, "m"),
];

const DECLARATION: Record<Dialect, (escaped: string) => RegExp> = {
  typescript: (name) => new RegExp(`^[ \\t]*export\\s+(?:async\\s+)?function\\s+${name}\\b`, "m"),
  // Any run of modifiers and attributes — `public static`, `@inlinable private`, `mutating` — then
  // `func name`, then either the parameter list or the generic clause before it.
  swift: (name) => new RegExp(`^[ \\t]*(?:(?:@[\\w.():, ]+|[A-Za-z_]\\w*)[ \\t]+)*func\\s+${name}\\s*[(<]`, "m"),
};

/**
 * The first and last line of a function, by brace matching over the masked source so a `}` in a string
 * or a comment cannot end it early.
 *
 * A stand-in, and it says so: from Phase 5 the range arrives in the `TestPlan`, which knows it from the
 * module the planner actually read. Until then the verifier has to find the function itself, and
 * finding nothing is an answer — the caller mutates the whole file and pays for it.
 */
export function deriveLineRange(
  source: string,
  functionName: string,
  dialect: Dialect = "typescript",
): readonly [number, number] | null {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const masked = mask(source, dialect);

  const patterns = dialect === "typescript" ? TS_DECLARATIONS(escaped) : [DECLARATION[dialect](escaped)];
  for (const pattern of patterns) {
    const declaration = pattern.exec(masked);
    if (!declaration) continue;
    const range = bodyRange(source, masked, declaration.index);
    if (range !== null) return range;
  }
  return null;
}

/**
 * Characters after which a `{` opens a **type**, not a body (ADR-0035).
 *
 * `): { percentage: string; color: Colour } => {` — the braces of the return-type annotation balance on
 * their own line, so brace-matching from the first `{` closes at the end of the *signature* and the body
 * is never in scope. Measured on a real NestJS module: an 18-mutant function, every one killable, was
 * reported as `NOT PLANNABLE — no mutants at all` — ADR-0016's own words for "drop this function".
 *
 * A `{` in one of these positions is a type; a `{` after anything else — most usefully after the `}` that
 * closed the annotation — is the body. That also handles `): A | { b } | { c } {`, where the naive "skip
 * one group" rule would take the second alternative for the body.
 */
const TYPE_POSITION = new Set([":", "|", "&", "<", ","]);

/**
 * Keywords after which a `{` opens a type, because a type position is not always a punctuation mark
 * (ADR-0039). `static isValidationError<T extends { isValid: boolean }>(` derived as the signature line
 * alone — one line — and the probe then said `NOT PLANNABLE — no mutants at all` about a function whose
 * hand-ranged control returns a mutant that a test kills.
 *
 * That sentence has now been checked four times — ADR-0030, ADR-0033 #4, ADR-0035, and this — and has
 * been wrong all four. See ADR-0039 on whether this should be an AST rather than a scanner at all.
 */
const TYPE_KEYWORD = new Set(["extends", "keyof", "infer", "is", "as", "implements", "satisfies", "typeof", "in"]);

/** The last character before `at` that is not whitespace. Comments are already blanked to spaces. */
function previousSignificant(masked: string, at: number): string {
  for (let i = at - 1; i >= 0; i -= 1) {
    const c = masked[i] ?? "";
    if (!/\s/.test(c)) return c;
  }
  return "";
}

/** The identifier ending just before `at`, ignoring whitespace. `""` when the last token is punctuation. */
function previousWord(masked: string, at: number): string {
  let end = at;
  while (end > 0 && /\s/.test(masked[end - 1] ?? "")) end -= 1;
  let start = end;
  while (start > 0 && /[A-Za-z_$]/.test(masked[start - 1] ?? "")) start -= 1;
  return masked.slice(start, end);
}

/** Does the `{` at `i` open a type rather than a body? */
function opensType(masked: string, i: number): boolean {
  return TYPE_POSITION.has(previousSignificant(masked, i)) || TYPE_KEYWORD.has(previousWord(masked, i));
}

/** The index just past the `}` matching the `{` at `open`, or `-1` if it never closes. */
function pastBraceGroup(masked: string, open: number): number {
  let braces = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === "{") braces += 1;
    else if (masked[i] === "}") {
      braces -= 1;
      if (braces === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * From a declaration's first character to the last line of its body.
 *
 * Two body shapes, because an arrow function need not have a block: `const f = (x) => x * 2;` ends at the
 * semicolon, and brace-matching from the next `{` would run off into whatever comes after it — silently
 * returning a range covering several unrelated functions, which ADR-0013 makes expensive.
 *
 * And one shape that is not a body at all: a return-type annotation. See `TYPE_POSITION`.
 */
function bodyRange(source: string, masked: string, from: number): readonly [number, number] | null {
  const lineOf = (at: number): number => source.slice(0, at).split("\n").length;

  // Where the body starts: the first `{` that is neither inside the parameter list nor part of a type
  // annotation, or the `=>` of a concise arrow body, whichever comes first.
  let depth = 0;
  let open = -1;
  let arrow = -1;
  for (let i = from; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (depth === 0 && c === "=" && masked[i + 1] === ">") { arrow = i; break; }
    else if (depth === 0 && c === "{") {
      if (opensType(masked, i)) {
        const past = pastBraceGroup(masked, i);
        if (past === -1) return null;
        i = past - 1; // the loop's own increment steps past the closing brace
        continue;
      }
      open = i;
      break;
    }
    else if (depth === 0 && c === "\n" && open === -1 && arrow === -1 && i > from) {
      // A declaration whose line ends without opening anything is not a declaration we can bound.
      const rest = masked.slice(from, i);
      if (!/[({<=]/.test(rest)) return null;
    }
  }

  if (arrow !== -1) {
    // `=> {` is still a block body; `=> expr` ends at the statement's end.
    const after = masked.slice(arrow + 2);
    const brace = /^\s*\{/.exec(after);
    if (brace) open = arrow + 2 + brace[0].length - 1;
    else {
      const end = after.search(/;|\n\s*\n/);
      return [lineOf(from), lineOf(end === -1 ? masked.length - 1 : arrow + 2 + end)];
    }
  }

  if (open === -1) return null;

  let braces = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === "{") braces += 1;
    else if (masked[i] === "}") {
      braces -= 1;
      if (braces === 0) return [lineOf(from), lineOf(i)];
    }
  }
  return null;
}
