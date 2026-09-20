// A `TestPlan` on disk → the things the worker and the two verifiers actually need.
//
// The plan is written by a planner that read a module; the verifiers take an explicit target. Nothing
// in between existed until now, and three of the joins are not in the contract, for reasons that are
// worth stating rather than discovering:
//
//   * **`projectDir`.** `module` is a path to a source *file*, so the package root is found by walking
//     up to the nearest `package.json` / `Package.swift` (ADR-0014). Unambiguous in every layout we
//     have, and no contract change.
//   * **`test_target`.** Swift only, optional, and now in the contract — ADR-0014 has the argument.
//   * **`imports_hint`.** `WorkerTask` carries it and `TestPlan` does not, so it is derived here from
//     where the candidate is about to be written. It includes the `.js` extension when, and only when,
//     the project's tsconfig asks for it: a worker that omits an extension nobody told it about fails
//     the compile stage, and the discard rate then reports on our tsconfig instead of on the model
//     (`fixtures/ts-fixture/README.md` makes the same argument the other way round).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { TestPlan, type Candidate, type PlannedFunction, type ShapeKind, type Verdict, type WorkerTask } from "./schemas.js";
import { isTestRunner, verifyTs, type TestRunner, type TsTarget } from "./verifier/ts.js";
import { verifySwift, type SwiftFramework, type SwiftTarget } from "./verifier/swift.js";
import { deriveLineRange, safeName, testDirFor } from "./verifier/shared.js";

// Re-exported from where it lives now: `doctor` asks the same question before a run, and importing
// this module from there would close a cycle through `serve` (ADR-0076).
export { testDirFor } from "./verifier/shared.js";

/** The plan is wrong, missing, or does not describe the code on disk. Not a machine problem. */
export class PlanError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

/**
 * `source_sha` is the sha-256 of the function's text as `line_range` slices it, hex — defined in the
 * spec rather than left to the planner, because the run recomputes it and a hash function agreed by
 * coincidence is a hash function that stops agreeing.
 */
export const sourceSha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** 1-based, inclusive, as `line_range` records it. */
export const sliceLines = (source: string, [from, to]: readonly [number, number]): string =>
  source.split("\n").slice(Math.max(0, from - 1), to).join("\n");

// ── where the project is ──────────────────────────────────────────────────────────────────────────

const ROOT_MARKER: Record<string, string> = { typescript: "package.json", swift: "Package.swift" };

/**
 * Walk up from the module to the nearest package root. Stops at the filesystem root and says what it
 * was looking for, because "cannot find package.json" is an answer and a default guess is not.
 */
export function findProjectRoot(moduleFile: string, language: string): string {
  const marker = ROOT_MARKER[language];
  if (marker === undefined) throw new PlanError(`no verifier for ${language} — sidecrew verifies typescript and swift`);
  let dir = dirname(resolve(moduleFile));
  for (;;) {
    if (existsSync(join(dir, marker))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new PlanError(`no ${marker} above ${moduleFile} — sidecrew cannot tell which project ${basename(moduleFile)} belongs to`);
    dir = up;
  }
}


/** Directories that never contain a project's own tests and are expensive to walk. */
const NOT_TESTS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".sidecrew", "reports"]);

/**
 * `.test.ts` or `.spec.ts` — whichever this project already uses (ADR-0032).
 *
 * It is not cosmetic, and the cost of getting it wrong is invisible. The **pass** stage is safe either
 * way, because `jest --ci --runTestsByPath` takes the path literally (ADR-0028). The **mutation** stage is
 * not: Stryker runs jest under the *project's own* config, and a NestJS project's
 * `testRegex: '.*\.spec\.ts$'` simply does not match a file called `foo.test.ts`. Jest then finds
 * nothing to run, every mutant comes back `NoCoverage`, `killed` is 0 — and the verdict is
 * indistinguishable from a test that covers nothing. Predicted in
 * `experiments/recon/project-a-and-b.md` before any run, which is why it is fixed here rather than
 * discovered as a survival rate of zero.
 *
 * Decided by counting what is on disk rather than by parsing a jest config, because the config may be
 * TypeScript, may live in `package.json`, may set neither key and rely on jest's defaults — and because
 * the files are the thing a human will compare the candidate against when they come to keep it.
 */
export function testSuffixFor(projectDir: string, limit = 400): ".test.ts" | ".spec.ts" {
  let test = 0;
  let spec = 0;
  let seen = 0;

  const walk = (dir: string): void => {
    if (seen >= limit) return;
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= limit) return;
      if (entry.isDirectory()) {
        if (!NOT_TESTS.has(entry.name) && !entry.name.startsWith(".")) walk(join(dir, entry.name));
        continue;
      }
      if (/\.test\.[cm]?tsx?$/.test(entry.name)) { test += 1; seen += 1; }
      else if (/\.spec\.[cm]?tsx?$/.test(entry.name)) { spec += 1; seen += 1; }
    }
  };
  walk(resolve(projectDir));

  // Ties and empty projects go to `.test.ts`: it is jest's and vitest's default, so a project that has
  // expressed no preference is likeliest to match it.
  return spec > test ? ".spec.ts" : ".test.ts";
}

/**
 * Does this project's TypeScript resolution demand a `.js` on relative imports? `NodeNext` / `Node16`
 * do; `Bundler` and the classic modes do not. Read off the tsconfig rather than assumed, and a
 * tsconfig we cannot read means the common case.
 */
export function wantsJsExtension(projectDir: string, tsconfig = "tsconfig.json"): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(projectDir, tsconfig), "utf8");
  } catch {
    return false;
  }
  const value = /"(?:moduleResolution|module)"\s*:\s*"(node16|nodenext)"/i.exec(raw);
  return value !== null;
}

// ── the plan, loaded ──────────────────────────────────────────────────────────────────────────────

export interface LoadedPlan {
  plan: TestPlan;
  /** Absolute path to the plan file; exemplars are resolved against its directory. */
  planPath: string;
  /** Absolute path to the module under test. */
  modulePath: string;
  /** Package root, found by walking up from the module. */
  projectDir: string;
  /** The module relative to `projectDir` — what both verifiers call `sourceFile`. */
  sourceFile: string;
  source: string;
  /** Shape kind → the exemplar's full text. */
  exemplars: Map<ShapeKind, string>;
}

/**
 * `module` is resolved against the current directory first and the plan's own directory second. Both
 * spellings occur in practice — a plan written by the planner names the module the way the user typed
 * it, and a plan moved next to the code names it relatively — and failing on one of them would be a
 * paper cut with no upside. The error names both attempts.
 */
const resolveModule = (plan: TestPlan, planPath: string): string => {
  const candidates = [resolve(plan.module), resolve(dirname(planPath), plan.module)];
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) {
    throw new PlanError(`plan's module ${plan.module} is not on disk — looked in ${candidates.join(" and ")}`);
  }
  return found;
};

export async function loadPlan(planPath: string): Promise<LoadedPlan> {
  const abs = resolve(planPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(abs, "utf8")) as unknown;
  } catch (e) {
    throw new PlanError(`${planPath} is not readable JSON: ${String((e as Error).message)}`);
  }
  const result = TestPlan.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new PlanError(`${planPath} is not a TestPlan: ${first?.path.join(".")} ${first?.message}`);
  }
  const plan = result.data;
  const modulePath = resolveModule(plan, abs);
  const projectDir = findProjectRoot(modulePath, plan.language);
  const source = await readFile(modulePath, "utf8");

  const exemplars = new Map<ShapeKind, string>();
  for (const shape of plan.shapes) {
    const path = resolve(dirname(abs), shape.exemplar);
    if (!existsSync(path)) throw new PlanError(`exemplar for ${shape.kind} is not on disk: ${shape.exemplar} (resolved to ${path})`);
    exemplars.set(shape.kind, await readFile(path, "utf8"));
  }

  return {
    plan,
    planPath: abs,
    modulePath,
    projectDir,
    sourceFile: relative(projectDir, modulePath).split(sep).join("/"),
    source,
    exemplars,
  };
}

// ── staleness ─────────────────────────────────────────────────────────────────────────────────────

export interface Stale {
  name: string;
  expected: string;
  actual: string;
}

/**
 * Which functions no longer hash to what the plan says.
 *
 * This is cheap and it is checked before a single token is spent, because ADR-0013 raised the stakes:
 * a stale `line_range` does not merely describe the wrong function, it *mutates the wrong lines*, and
 * the verdict that comes back is about code nobody asked to test. Phase 5's `sidecrew plan --validate`
 * is the standalone report; a run refuses on its own rather than trusting that someone ran it.
 */
export const staleFunctions = (plan: TestPlan, source: string): Stale[] =>
  plan.functions.flatMap((fn) => {
    const actual = sourceSha(sliceLines(source, fn.line_range));
    return actual === fn.source_sha ? [] : [{ name: fn.name, expected: fn.source_sha, actual }];
  });

// ── tasks ─────────────────────────────────────────────────────────────────────────────────────────

/** `<function>:<shape>:<attempt>`. Parsed back by `sidecrew verify`, so it is a format, not a label. */
export const taskId = (fn: string, shape: ShapeKind, attempt = 0): string => `${fn}:${shape}:${attempt}`;

export const functionOfTaskId = (id: string): string => id.split(":")[0] ?? id;

/** Where the candidate will be imported from, seen from the directory it is about to be written into. */
/**
 * How this module actually exposes `name` — which is not always "a named export" (ADR-0033).
 *
 * `importsHint` used to write `import { foo } from "…"` unconditionally. On a NestJS codebase that is
 * wrong for **1,465 of ~1,504 functions**: the idiom is `export default class AssetUtil` holding static
 * methods, and there is no named export at all. The prompt then contradicted itself — a false
 * `Import it like this:` line, with an exemplar importing correctly ten lines below — and the measured
 * result was that **18 of 20 candidates followed the wrong instruction over the right example**.
 *
 * Read off the module's own source, because that is the only thing that knows. A named export wins when
 * both exist: it is the narrower import and it is what the function's own declaration says.
 */
export type ExportStyle =
  | { kind: "named" }
  | { kind: "default"; local: string }
  /** `export class Utils { static f() {} }` — import the class by name, reach `f` through it. */
  | { kind: "namedClass"; local: string };

export function exportStyleFor(source: string, name: string): ExportStyle {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = [
    new RegExp(`^[ \\t]*export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${escaped}\\b`, "m"),
    new RegExp(`^[ \\t]*export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`, "m"),
  ];
  if (named.some((re) => re.test(source))) return { kind: "named" };

  // `export default class AssetUtil { … }` or `export default AssetUtil;`
  const declared = /^[ \t]*export\s+default\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/m.exec(source);
  if (declared) return { kind: "default", local: declared[1]! };
  const referenced = /^[ \t]*export\s+default\s+([A-Za-z_$][\w$]*)\s*;/m.exec(source);
  if (referenced) return { kind: "default", local: referenced[1]! };

  // `export class ImportFileUtils { static hasCellContent(…) {} }` — the class is exported and the
  // member is not, so neither branch above fires and the fallback emitted `import { hasCellContent }`,
  // which cannot compile. Measured: all 8 tasks of one module carried that hint (ADR-0040).
  const owner = owningClass(source, escaped);
  if (owner !== null) return { kind: "namedClass", local: owner };

  // Nothing recognisable. A named import is the ordinary case and the one the fixtures use, so it stays
  // the fallback — but it is a fallback now rather than an assumption.
  return { kind: "named" };
}

/**
 * The exported class that declares `name` as a member, if one does.
 *
 * Scoped to each `export class` block so a module with several of them names the right one: a member is
 * attributed to the class whose declaration most recently precedes it.
 */
function owningClass(source: string, escaped: string): string | null {
  const member = new RegExp(
    `^[ \\t]+(?:(?:public|private|protected|static|readonly|abstract|override|async)\\s+)*${escaped}\\s*[(<=:]`,
    "m",
  );
  const classes = [...source.matchAll(/^[ \t]*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm)];
  for (let i = 0; i < classes.length; i += 1) {
    const from = classes[i]!.index ?? 0;
    const to = classes[i + 1]?.index ?? source.length;
    if (member.test(source.slice(from, to))) return classes[i]![1]!;
  }
  return null;
}

export function importsHint(loaded: LoadedPlan, fn: PlannedFunction): string {
  if (loaded.plan.language === "swift") {
    // SwiftPM: the module is the directory under `Sources/`, and a test target reaches its internals
    // only through `@testable`.
    const parts = loaded.sourceFile.split("/");
    const module = parts[0] === "Sources" && parts.length > 1 ? parts[1]! : basename(loaded.projectDir);
    return `@testable import ${module}`;
  }
  const fromDir = join(loaded.projectDir, testDirFor(loaded.projectDir));
  const withoutExt = join(dirname(loaded.modulePath), basename(loaded.modulePath, extname(loaded.modulePath)));
  const rel = relative(fromDir, withoutExt).split(sep).join("/");
  const specifier = rel.startsWith(".") ? rel : `./${rel}`;
  const suffix = wantsJsExtension(loaded.projectDir) ? ".js" : "";

  const style = exportStyleFor(loaded.source, fn.name);
  if (style.kind === "default") return `import ${style.local} from "${specifier}${suffix}";`;
  if (style.kind === "namedClass") return `import { ${style.local} } from "${specifier}${suffix}";`;
  return `import { ${fn.name} } from "${specifier}${suffix}";`;
}

export interface BuildTaskOpts {
  attempt?: number;
  retryOf?: string;
  previousError?: string;
}

export function buildTask(loaded: LoadedPlan, fn: PlannedFunction, shape: ShapeKind, opts: BuildTaskOpts = {}): WorkerTask {
  const planned = loaded.plan.shapes.find((s) => s.kind === shape);
  if (planned === undefined) throw new PlanError(`function ${fn.name} asks for shape ${shape}, which the plan does not define`);
  const exemplar = loaded.exemplars.get(shape);
  if (exemplar === undefined) throw new PlanError(`no exemplar loaded for shape ${shape}`);

  return {
    task_id: taskId(fn.name, shape, opts.attempt ?? 0),
    language: loaded.plan.language,
    test_framework: loaded.plan.test_framework,
    function: {
      name: fn.name,
      signature: fn.signature,
      source: sliceLines(loaded.source, fn.line_range),
      source_sha: fn.source_sha,
    },
    imports_hint: importsHint(loaded, fn),
    shape: { kind: shape, rules: planned.rules },
    exemplar_source: exemplar,
    retry_of: opts.retryOf ?? null,
    previous_error: opts.previousError ?? null,
  };
}

/** Every function × shape the plan asks for, in plan order. */
export const buildTasks = (loaded: LoadedPlan): WorkerTask[] =>
  loaded.plan.functions.flatMap((fn) => fn.shapes.map((shape) => buildTask(loaded, fn, shape)));

// ── verification ──────────────────────────────────────────────────────────────────────────────────

const SWIFT_FRAMEWORKS = new Set<SwiftFramework>(["xctest", "swift-testing"]);

export interface VerifyOpts {
  /** Stryker's per-verification concurrency, from `planConcurrency`. Muter has no equivalent. */
  concurrency?: number;
  /** Overrides `TestPlan.test_target` for a one-off (`sidecrew verify --test-target`), ADR-0014. */
  testTarget?: string;
  keepSandbox?: boolean;
}

/**
 * The function's line range, from the plan when the plan knows it and from the module when it does
 * not.
 *
 * The second case is not a loophole, it is the exemplar loop: the planner writes an exemplar for a
 * shape, verifies it, and fixes it until it survives — and an exemplar is routinely about a function
 * the plan does not list, because listing it would hand the worker the answer. So an unplanned name
 * is allowed, but only if the *module* has a function by that name. A typo therefore fails here,
 * naming both sets, instead of quietly mutating the whole file and grading a candidate on functions
 * nobody asked about (ADR-0013).
 */
export function rangeFor(loaded: LoadedPlan, name: string): readonly [number, number] {
  const planned = loaded.plan.functions.find((f) => f.name === name);
  if (planned !== undefined) return planned.line_range;
  const dialect = loaded.plan.language === "swift" ? "swift" : "typescript";
  const derived = deriveLineRange(loaded.source, name, dialect, {
    projectDir: loaded.projectDir, fileName: loaded.modulePath,
  });
  if (derived === null) {
    throw new PlanError(
      `neither ${basename(loaded.planPath)} nor ${loaded.sourceFile} has a function called ${name} — ` +
      `the plan has ${loaded.plan.functions.map((f) => f.name).join(", ")}`,
    );
  }
  return derived;
}

/**
 * `TestPlan.test_framework` → the runner the verifier will drive (ADR-0028).
 *
 * The contract lets the framework be any non-empty string, deliberately: refusing a project in the
 * schema would refuse it before the verifier had a chance to say whether it could handle it. This is
 * where the verifier says so, and it says it by name — a plan asking for `ava` or `mocha` gets a
 * `PlanError` listing what there is, rather than a vitest command that fails three stages later looking
 * like a bad candidate.
 */
export function runnerFor(framework: string): TestRunner {
  if (isTestRunner(framework)) return framework;
  throw new PlanError(
    `the TypeScript verifier drives vitest and jest, not ${framework} — ` +
    "the runner has to be one it can ask Stryker to mutate under",
  );
}

/**
 * The exemplar a task was shown, from its `task_id`'s shape. `undefined` when the id names no shape the
 * plan defines — `sidecrew verify` on a hand-written file, for instance, whose id we invented.
 */
export function exemplarForTask(loaded: LoadedPlan, taskId: string): string | undefined {
  const shape = taskId.split(":")[1];
  return shape === undefined ? undefined : loaded.exemplars.get(shape as ShapeKind);
}

export const tsTargetFor = (loaded: LoadedPlan, name: string, candidate: Candidate): TsTarget => ({
  projectDir: loaded.projectDir,
  sourceFile: loaded.sourceFile,
  functionName: name,
  lineRange: rangeFor(loaded, name),
  runner: runnerFor(loaded.plan.test_framework),
  // The shape's own exemplar, so a candidate that is the exemplar handed back is caught (ADR-0033).
  ...(exemplarForTask(loaded, candidate.task_id) === undefined ? {} : { exemplar: exemplarForTask(loaded, candidate.task_id)! }),
  // The project's own directory *and* its own suffix. The suffix is load-bearing for the mutation
  // stage, which runs jest under the project's config rather than by path (ADR-0032).
  testFile: `${testDirFor(loaded.projectDir)}/${safeName(candidate.task_id)}${testSuffixFor(loaded.projectDir)}`,
});

export const swiftTargetFor = (loaded: LoadedPlan, name: string, candidate: Candidate, opts: VerifyOpts = {}): SwiftTarget => {
  const framework = loaded.plan.test_framework as SwiftFramework;
  if (!SWIFT_FRAMEWORKS.has(framework)) {
    throw new PlanError(`the Swift verifier drives xctest and swift-testing, not ${loaded.plan.test_framework}`);
  }
  // Call site beats plan beats the verifier's own "there is only one" (ADR-0014). Leaving it undefined
  // is what makes verifySwift refuse a multi-target package by name instead of picking one.
  const testTarget = opts.testTarget ?? loaded.plan.test_target;
  return {
    projectDir: loaded.projectDir,
    sourceFile: loaded.sourceFile,
    functionName: name,
    lineRange: rangeFor(loaded, name),
    framework,
    ...(testTarget === undefined ? {} : { testTarget }),
    testFile: `${safeName(candidate.task_id)}.swift`,
  };
};

/**
 * One candidate → one `Verdict`, through whichever verifier the plan's language names.
 *
 * The dispatch is the whole job: both verifiers were built to take an explicit target precisely so
 * that the mapping from a plan would live in one place and be readable. Neither is touched here.
 */
export async function verifyCandidate(
  loaded: LoadedPlan,
  candidate: Candidate,
  functionName = functionOfTaskId(candidate.task_id),
  opts: VerifyOpts = {},
): Promise<Verdict> {
  if (loaded.plan.language === "typescript") {
    return verifyTs(candidate, {
      target: tsTargetFor(loaded, functionName, candidate),
      concurrency: opts.concurrency,
      keepSandbox: opts.keepSandbox,
    });
  }
  if (loaded.plan.language === "swift") {
    return verifySwift(candidate, {
      target: swiftTargetFor(loaded, functionName, candidate, opts),
      keepSandbox: opts.keepSandbox,
    });
  }
  throw new PlanError(`no verifier for ${loaded.plan.language} yet — Phase 9 owns python and kotlin`);
}
