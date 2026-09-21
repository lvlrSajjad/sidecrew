// TypeScript verifier: tautology → tsc → vitest | jest → StrykerJS, scoped to one function of one file.
//
// Two runners, one pipeline (ADR-0028). Vitest was the only one until Phase 9, which is a sentence that
// reads as a preference and was actually a blocker: React Native defaults to Jest, Nest defaults to Jest,
// and `jest` had been sitting in `KNOWN_TEST_FRAMEWORKS` as an advisory string that nothing drove. The
// framework is on the `TestPlan` already, so this is dispatch rather than configuration.
//
// Survive ⇔ compiles ∧ passes on the original code ∧ kills ≥ 1 mutant of the function under test ∧
// non-tautological (CLAUDE.md #2). Everything here exists to make each of those four words mean what
// it says, and the two that took measurement to get right are written up in ADR-0004:
//
//   * the candidate runs in a sandbox with the project's **own tests removed**, because a mutant killed
//     by a test that already existed is not evidence about the candidate;
//   * Stryker's incremental cache is confined to that sandbox, because a cache shared between
//     candidates hands one candidate another's kills — measured, not feared.
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { DEFAULT_VERIFIER_CONCURRENCY } from "../concurrency.js";
import { run } from "../exec.js";
import { MutationResult, survives, Verdict, type Candidate, type Stage } from "../schemas.js";
import { TEST_FILE_PATTERN } from "../confinement.js";
import { analyseTautology, type TautologyReport } from "./tautology.js";
import {
  deriveLineRange, isResolvable, isTestRunner, jestConfigEntry, looksLikeOom, output, resolveNodeModules, safeName,
  STRYKER_PLUGIN, TEST_RUNNERS, truncateError, VerifierSetupError, type TestRunner,
} from "./shared.js";

// Re-exported so this module stays the one place a caller has to know about to verify TypeScript.
// The implementations moved to `shared.ts` in Phase 3, where the Swift verifier could reach them.
export { deriveLineRange, isTestRunner, jestConfigEntry, looksLikeOom, STRYKER_PLUGIN, TEST_RUNNERS, truncateError, VerifierSetupError };
export type { TestRunner };

/** What the candidate was asked to test. Phase 4 fills this from the `TestPlan`; Phase 2 is explicit. */
export interface TsTarget {
  /** Project root: the thing with a package.json, a tsconfig and an installed node_modules. */
  projectDir: string;
  /** Source file under test, relative to `projectDir`. */
  sourceFile: string;
  /** The function under test. The tautology check and the mutation scope are both about this name. */
  functionName: string;
  /**
   * 1-based and inclusive, as `TestPlan.functions[].line_range` records it. Stryker then mutates only
   * those lines, which is what makes "kills ≥ 1 mutant **of the function under test**" checkable
   * rather than merely stated — and, measured on the fixture, what takes the mutation stage from 30 s
   * to 9 s, because the other four functions in the file stop being mutated for nobody.
   *
   * Three values, three meanings: a range is used as given; `null` mutates the whole file on purpose;
   * omitted derives the range from the source, which is what Phase 2 does because there is no planner
   * yet to supply one.
   */
  lineRange?: readonly [number, number] | null;
  /** Where the candidate lands inside the sandbox, relative to `projectDir`. */
  testFile?: string;
  /** Relative to `projectDir`. */
  tsconfig?: string;
  /**
   * Which runner to drive. Defaults to vitest, which is what every plan written before Phase 9 means
   * by saying nothing. `plan.ts` fills it from `TestPlan.test_framework`.
   */
  runner?: TestRunner;
  /** The exemplar this candidate was shown, so a verbatim copy of it can be caught (ADR-0033). */
  exemplar?: string;
  /**
   * Jest's config file, relative to `projectDir`. Detected when omitted; passed to Stryker's jest-runner
   * as `configFile`, because a project whose jest config carries a `preset`, `setupFiles` and
   * `transformIgnorePatterns` — which is every React Native project — does not survive Stryker guessing.
   */
  jestConfig?: string;
}

export interface StageTimeouts {
  compile: number;
  pass: number;
  mutation: number;
}

/** Mutation runs are minutes, not seconds: `exec.ts`'s 60 s default would kill every one of them. */
export const DEFAULT_TIMEOUTS: StageTimeouts = { compile: 120_000, pass: 120_000, mutation: 900_000 };

/**
 * Stryker's own default is `cpus - 1`. On the machine this project is sized around that is eight vitest
 * processes next to a resident 7B worker, which is how non-negotiable #5 gets broken by a default
 * nobody chose. Two is the number Phase 2 measured with, and it is no longer written here: Phase 4's
 * `planConcurrency` derives it from free RAM and hands it to `verifyTs` per run. This alias is what a
 * direct call with no run around it gets, and it points at the one definition rather than repeating
 * its value.
 */
export const DEFAULT_STRYKER_CONCURRENCY = DEFAULT_VERIFIER_CONCURRENCY;

export interface VerifyTsOpts {
  target: TsTarget;
  timeouts?: Partial<StageTimeouts>;
  concurrency?: number;
  /** Leave the sandbox on disk and print its path. For debugging a verdict you do not believe. */
  keepSandbox?: boolean;
  /** Where sandboxes are made. Defaults to the OS temp dir, deliberately outside the project. */
  sandboxRoot?: string;
}

/**
 * Anything matching this is a test, and tests are what the sandbox must not inherit.
 *
 * **Imported, not spelled again.** It was a fourth copy of the same regex until ADR-0081, and the four
 * agreed on everything except the one spelling that mattered — `app.e2e-spec.ts`. Workload #1 deletes
 * what this matches and workload #2a forbids editing it; those are opposite consequences of one fact
 * about a filename, and one fact should have one answer.
 */
export { TEST_FILE_PATTERN } from "../confinement.js";

/**
 * Never copied into a sandbox. `node_modules` is symlinked instead of copied; the rest is either
 * generated output or a cache that would make the run less reproducible than the copy it came from.
 * `__snapshots__` is here for a sharper reason: a snapshot written by somebody else's test run is a
 * recorded answer, and a candidate must not be graded against one.
 */
export const NEVER_COPY = new Set([
  "node_modules", ".git", ".sidecrew", "reports", ".stryker-tmp", "dist", "coverage", ".nyc_output", "__snapshots__",
]);

/**
 * Of those, the ones that may only be skipped at the **top level** (ADR-0033).
 *
 * The filter used to match a directory name at any depth, which is right for `node_modules` — they nest —
 * and catastrophic for the rest. Measured on a real NestJS codebase: `src/modules/reports/` is a
 * controller, a service, a module and two entities, and the sandbox silently deleted all five. `tsc` then
 * failed with `TS2307 Cannot find module` naming the project's own files, and the verdict said
 * **"did not compile"** — the worst available description of "your sandbox deleted five source files".
 *
 * `reports`, `dist` and `coverage` are perfectly ordinary names for a feature directory. They are output
 * directories only when they are where the build puts output, which is the project root.
 */
const TOP_LEVEL_ONLY = new Set([".sidecrew", "reports", "dist", "coverage", ".nyc_output"]);

/** Should this path be left out of the sandbox? `rel` is relative to the project root. */
export function skipFromSandbox(rel: string): boolean {
  const parts = rel.split(sep);
  if (parts.length === 0) return false;
  if (TOP_LEVEL_ONLY.has(parts[0]!) && parts.length >= 1) return true;
  // The rest nest legitimately and are never a source directory's name.
  return parts.some((part) => NEVER_COPY.has(part) && !TOP_LEVEL_ONLY.has(part));
}

// ── files named like tests that are not tests (ADR-0035) ──────────────────────────────────────────

/** Files whose text can import another file. Nothing else can rescue anything. */
const CODE_FILE = /\.[cm]?[jt]sx?$/;

/** `import … from "x"`, `import "x"`, `import("x")`, `require("x")`, `export … from "x"`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])([^"']+)\1/g;

const toPosix = (rel: string): string => rel.split(sep).join("/");
const withoutExtension = (path: string): string => path.replace(CODE_FILE, "");

/**
 * Of the files named like tests, the ones that are actually part of the project's own code.
 *
 * `TEST_FILE_PATTERN` matches a basename, anywhere, and that is what emptied the sandbox of
 * `src/modules/auth/auth.config.test.ts` — a NestJS configuration module that `test/util/test.setup.ts`
 * imports. `tsc` then failed on the project's own code, and **12 of 16 attempts died on that one line and
 * nothing else**. The verdict said "did not compile", about candidates nobody ever looked at, and the
 * run's survival rate was 0/8 where the same run with this one file restored was 3/8 (ADR-0035).
 *
 * The rule the pattern was reaching for is not "named like a test". It is **"nothing that stays imports
 * it"** — a test is a leaf of the import graph, which is exactly why removing tests is safe and removing
 * this file was not. So: seed with everything that is not test-named, follow the relative imports, and
 * whatever they reach is code regardless of what it is called. Transitive, because a rescued file's own
 * imports are kept code too.
 *
 * `files` is rel path → text for every code file that would otherwise be copied.
 */
export function rescuedFromTestName(files: ReadonlyMap<string, string>): Set<string> {
  const testNamed = new Map<string, string>(); // stem → rel
  for (const rel of files.keys()) {
    if (TEST_FILE_PATTERN.test(basename(rel))) testNamed.set(withoutExtension(toPosix(rel)), rel);
  }
  if (testNamed.size === 0) return new Set();

  const rescued = new Set<string>();
  let frontier = [...files.keys()].filter((rel) => !TEST_FILE_PATTERN.test(basename(rel)));

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const importer of frontier) {
      const from = posix.dirname(toPosix(importer));
      for (const [, , specifier] of (files.get(importer) ?? "").matchAll(SPECIFIER)) {
        // Only a relative specifier can name a file in this project. A bare one is a package, and a path
        // alias is not resolvable without the project's own resolver — noted in BACKLOG.
        if (specifier === undefined || !specifier.startsWith(".")) continue;
        // Extension-less, because a specifier may or may not carry one and a resolver would not care.
        // No `/index` candidate: a directory resolves to `index.ts`, which the pattern never matches.
        const resolved = withoutExtension(posix.normalize(posix.join(from, specifier)));
        const hit = testNamed.get(resolved);
        if (hit !== undefined && !rescued.has(hit)) {
          rescued.add(hit);
          next.push(hit);
        }
      }
    }
    frontier = next;
  }
  return rescued;
}

/**
 * Walk the project as the sandbox copy will, and work out which test-named files have to survive it.
 *
 * Reading every code file costs something and it is paid per candidate, because each candidate gets its
 * own sandbox. Measured on a 2,132-file NestJS project it is in the hundreds of milliseconds, against a
 * compile stage of 11.5 s and a mutation stage of 130–200 s. The alternative is the measured 0/8.
 */
/**
 * Directories the sandbox holds as symlinks, which Stryker cannot copy into its own sandbox.
 *
 * ```
 * ERROR Stryker ENOTSUP: operation not supported on socket, copyfile
 *   '…/sidecrew-ts-r5Wiev/.claude/skills' -> '…/.stryker-tmp/sandbox-PgnWGc/.claude/skills'
 * ```
 *
 * Observed on both project-a runs, a day apart: the project symlinks `.claude/agents` and
 * `.claude/skills` at its own authors' choice, `cp` faithfully reproduces them, and Stryker's `copyFile`
 * dies on the first one — a hard stop for the whole run, before any candidate is judged. It is the one
 * blocker the previous trial enumerated that ADR-0033 neither fixed nor recorded as unfixed.
 *
 * Naming them in `ignorePatterns` rather than dropping them from the sandbox is deliberate: `tsc` reads
 * through the symlink and still type-checks whatever is behind it, so the compile stage is unchanged.
 * Only Stryker's copy skips them. A project that symlinks a directory its *mutants* need would then get
 * a compile error from Stryker instead of a crash — worse to read, but scoped to that project, where the
 * crash is unconditional.
 */
async function symlinkedDirectories(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string): Promise<void> => {
    const entries = await readdir(at, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const abs = join(at, entry.name);
      const rel = relative(dir, abs);
      if (skipFromSandbox(rel) || rel === "node_modules") return;
      if (entry.isSymbolicLink()) {
        // A symlink to a file copies fine; only a directory breaks `copyFile`.
        const target = await stat(abs).catch(() => null);
        if (target?.isDirectory() === true) found.push(toPosix(rel));
        return;
      }
      if (entry.isDirectory()) await walk(abs);
    }));
  };
  await walk(dir);
  return found.sort();
}

async function surveyTestNames(projectDir: string): Promise<Set<string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const abs = join(dir, entry.name);
      if (skipFromSandbox(relative(projectDir, abs))) return;
      // `isDirectory` is false for a symlink, so this never follows one out of the project.
      if (entry.isDirectory()) return walk(abs);
      if (!entry.isFile() || !CODE_FILE.test(entry.name)) return;
      files.set(relative(projectDir, abs), await readFile(abs, "utf8"));
    }));
  };
  await walk(projectDir);
  return rescuedFromTestName(files);
}

// ── the Stryker configuration ─────────────────────────────────────────────────────────────────────

/** Where the json reporter writes, named here rather than defaulted because the verifier reads it. */
export const MUTATION_REPORT = ".sidecrew-mutation/mutation.json";
/** Written into the sandbox per candidate; the project's own config, if any, is left alone. */
export const STRYKER_CONFIG = "sidecrew.stryker.config.mjs";

export interface StrykerConfigOpts {
  tsconfig?: string;
  concurrency?: number;
  /** Overridden per run by `--mutate`; what is written here is the sane default for a human. */
  mutate?: string[];
  timeoutMs?: number;
  runner?: TestRunner;
  /** Jest only: the project's own config file, relative to the project root. */
  jestConfig?: string;
  /** Sandbox-relative directories Stryker must not copy — symlinked ones (ADR-0035). */
  ignorePatterns?: readonly string[];
  /** Absolute paths to plugins Stryker's own glob cannot see, e.g. under pnpm (ADR-0036). */
  plugins?: readonly string[];
}

/**
 * Stryker's dry run dying on its own instrumentation, which is what ts-jest's diagnostics do to it.
 *
 * Named so the message can say *why* rather than showing a page of errors about `stryMutAct_9fa48` and
 * leaving the reader to work out that no line of it is about their test (ADR-0028, ADR-0036).
 */
const TS_JEST_INSTRUMENTATION = /\bstry(?:MutAct|Cov|NS)_[0-9a-f]+\b/;

/**
 * The Stryker plugins the verifier depends on, as absolute paths, **only when Stryker cannot find them
 * itself** (ADR-0036).
 *
 * Stryker's plugin glob resolves against **its own install directory**, not the project's:
 *
 * ```js
 * const pluginDirectory = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)), org);
 * ```
 *
 * Under npm or yarn that lands on the project's `node_modules/@stryker-mutator/`, which holds everything.
 * Under **pnpm** it lands on `.pnpm/@stryker-mutator+core@8.7.1/node_modules/@stryker-mutator/`, which
 * holds `api`, `core`, `instrumenter`, `util` — and not the runner or the checker, because those are the
 * *project's* dependencies and not core's. Stryker then reports:
 *
 * ```
 * WARN OptionsValidator Unknown stryker config option "jest" … Stryker loaded plugins from: ["@stryker-mutator/*"]
 * ERROR Stryker Cannot find Checker plugin "typescript". In fact, no Checker plugins were loaded.
 * ```
 *
 * This is the project-b blocker, reproduced here in a six-file pnpm project with sidecrew's sandbox out
 * of the picture. It also explains the thing that made no sense about it: the trial added
 * `public-hoist-pattern[]=@stryker-mutator/*` and reinstalled, the plugins appeared in the project's
 * `node_modules/@stryker-mutator/`, and Stryker still loaded none — because the glob never looks there.
 *
 * Naming the plugins as bare specifiers does **not** work either: `importModule` is a plain
 * `import(name)` from inside core, so pnpm refuses a package core does not declare. The one branch that
 * escapes is an absolute path, which Stryker turns into a `file://` URL and imports directly.
 *
 * Returns `[]` when the glob can already see everything, so a hoisted project's config is byte-identical
 * to what it was and this carries no risk for the layout that already worked.
 */
export function strykerPluginPaths(projectDir: string, runner: TestRunner): string[] {
  const needed = [STRYKER_PLUGIN[runner], "@stryker-mutator/typescript-checker"];
  const require_ = createRequire(join(resolve(projectDir), "package.json"));
  let globDir: string;
  try {
    // Stryker globs the directory its own package sits in, which is the parent of core's directory.
    globDir = dirname(dirname(require_.resolve("@stryker-mutator/core/package.json")));
  } catch {
    return [];
  }
  const invisible = needed.filter((pkg) => !existsSync(join(globDir, pkg.slice(pkg.indexOf("/") + 1))));
  if (invisible.length === 0) return [];

  const paths: string[] = [];
  for (const pkg of needed) {
    try {
      // `require.resolve(pkg)` is the wrong entry point and sometimes no entry point at all: both of
      // these packages are ESM-only, `jest-runner` maps `require` to a CJS jest-environment shim, and
      // `typescript-checker` declares only `import`, so CJS resolution throws. Only `<pkg>/package.json`
      // is reliably resolvable, and the entry is read from there.
      const manifest = require_.resolve(`${pkg}/package.json`);
      const entry = esmEntry(JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>);
      if (entry !== null) paths.push(join(dirname(manifest), entry));
    } catch {
      // Not installed is a different failure, and `verifyTs` already refuses for it by name.
    }
  }
  return paths;
}

/** The path a `import "<pkg>"` would load, from the package's own manifest. */
function esmEntry(manifest: Record<string, unknown>): string | null {
  const pick = (node: unknown, depth = 0): string | null => {
    if (typeof node === "string") return node;
    if (depth > 4 || node === null || typeof node !== "object") return null;
    const conditions = node as Record<string, unknown>;
    for (const key of ["import", "module", "default"]) {
      if (key in conditions) {
        const found = pick(conditions[key], depth + 1);
        if (found !== null) return found;
      }
    }
    return null;
  };
  const exports_ = manifest.exports;
  const root = typeof exports_ === "object" && exports_ !== null && "." in (exports_ as Record<string, unknown>)
    ? (exports_ as Record<string, unknown>)["."]
    : exports_;
  return pick(root) ?? pick(manifest.module) ?? pick(manifest.main);
}

/** Written into the sandbox only when the project's own tsconfig does not cover the candidate. */
export const SIDECREW_TSCONFIG = ".sidecrew-tsconfig.json";

/**
 * Does this project need the derived tsconfig? Learnt from the first candidate and reused for the rest.
 *
 * Keyed by project, tsconfig and the directory the candidate goes in — the three things the answer
 * depends on — and never by the candidate, because the answer does not. A wrong entry costs nothing:
 * `typecheckedCandidate` still checks every time, and the widening path still fires if it was false.
 */
const NEEDS_WIDENING = new Map<string, boolean>();

/**
 * Did `tsc` actually open the candidate? (ADR-0037)
 *
 * **The defect this exists for.** `testDirFor` picks a test directory; the project's `tsconfig.json`
 * has an `include`; nothing ever checked that the second covers the first. On a real React project
 * `testDirFor` returned `test/` — a directory that project does not have, its tests living in
 * `src/utils/tests/` — while `include` was `["src", …]`. So the candidate was written outside every
 * include glob and `tsc --noEmit -p tsconfig.json` type-checked the project **and never opened the
 * candidate**, reporting `compile ok` either way.
 *
 * Reproduced here on `fixtures/ts-fixture` with `include: ["src"]`: a candidate carrying three type
 * errors that are silent at runtime — `const wrong: string = 42`, a wrong-typed constant, and a call
 * with too many arguments — **survived, `compile ok`, `pass ok`, mutation score 0.8.**
 *
 * That is worse than every blocker before it, and the difference is the direction of the failure. A
 * deleted source file, a missing plugin, a crashing instrumenter — all of those fail *closed*: loud,
 * and fixed within a trial. This one fails **open**. It manufactures a survivor, scores it, and
 * `sidecrew review` hands it to Claude as work that passed a real gate. The tool's entire claim is that
 * Claude only ever sees what survived compile → run → mutation; a compile stage that silently does not
 * compile makes that claim false while every verdict still says it is true.
 */
function typecheckedCandidate(compile: { stdout: string; stderr: string }, sandbox: string, testFile: string): boolean {
  // Both spellings of the sandbox, because `tmpdir()` on macOS is `/var/folders/…`, a symlink, and
  // `--listFiles` prints the resolved `/private/var/folders/…`. Comparing one to the other says the
  // candidate was never checked when it was — and this assertion refusing a good candidate is exactly
  // as bad as it passing a bad one.
  const wanted = new Set([resolve(sandbox, testFile), resolve(realpathSync.native(sandbox), testFile)]);
  // `--listFiles` prints one absolute path per line, including when there are also errors.
  return `${compile.stdout}\n${compile.stderr}`.split("\n").some((line) => wanted.has(resolve(line.trim())));
}

/**
 * `--listFiles` prints the whole program — thousands of paths on a real project — and the compile
 * stage's output is not a log, it is what the retry prompt and the escalation queue are built from
 * (ADR-0037). A diagnostic carries `(line,col): error TS…`; a file-list entry is a bare path.
 */
export function stripFileList(text: string): string {
  return text
    .split("\n")
    .filter((line) => !(line.startsWith("/") && !line.includes("): ") && !line.includes("error TS")))
    .join("\n")
    .trim();
}

/**
 * A tsconfig that is the project's own plus the candidate.
 *
 * `extends` inherits `include` and `exclude` from the parent when the child does not restate them, and
 * a `files` entry is additive to whatever `include` already matched — so this widens the program by
 * exactly one file and changes nothing else. It is written only when the parent has been *observed*
 * not to cover the candidate, so a project whose config is already right never sees it.
 */
export function derivedTsconfig(parent: string, testFile: string): string {
  const from = parent.startsWith(".") ? parent : `./${parent}`;
  return `${JSON.stringify({ extends: from, files: [testFile.split(sep).join("/")] }, null, 2)}\n`;
}

/**
 * The jest config sidecrew writes into the sandbox so ts-jest stops type-checking Stryker (ADR-0036).
 *
 * Not a standard jest config name, deliberately: `readInitialOptions` with no path must still find the
 * *project's* config and not this one.
 */
export const SIDECREW_JEST_CONFIG = ".sidecrew-jest.config.cjs";

/**
 * A jest config that is the project's own, plus `diagnostics: false` for ts-jest.
 *
 * **The problem, reproduced on a fixture rather than only on somebody's repo.** ts-jest type-checks by
 * default; Stryker instruments the source it mutates; so ts-jest type-checks Stryker's instrumentation
 * and the dry run dies with a page of errors about code nobody wrote — `Cannot assign to
 * 'stryMutAct_9fa48' because it is a function`, `Parameter 'id' implicitly has an 'any' type`. Every
 * candidate of an affected project fails, in the mutation stage, for a reason that has nothing to do
 * with the candidate. ADR-0028 found this and put the remedy in *the project's* config file; the
 * project-a trials then showed what that means in practice — a stock NestJS project cannot be mutated
 * at all, and the only trial that got a number had to edit the project to get it.
 *
 * **Why turning it off costs nothing.** sidecrew type-checks in a stage of its own: `tsc --noEmit` over
 * the whole project is the compile stage and runs first, and the mutants' type checking is Stryker's
 * `checkers: ["typescript"]`, which is what keeps uncompilable mutants out of the denominator
 * (ADR-0016). Two type checks remain. The redundant third is the one that breaks. Measured on the
 * fixture: with diagnostics on the mutation stage produces no report at all; with this shim the verdict
 * is byte-identical to the fixture's own `isolatedModules` config.
 *
 * **Why a file rather than Stryker's `jest.config` key.** That key is a *shallow* override —
 * `{...fromFile, ...config}` in the runner — so setting `globals` through it silently drops whatever
 * else the project had in `globals`, and `__DEV__` in `globals` is every React Native project. Loading
 * the project's config here and spreading it keeps everything.
 *
 * **Why `globals` rather than the transform.** It reaches ts-jest however the project configured it —
 * an explicit `transform`, a `preset: "ts-jest"`, or a `jest` key in package.json — and the transform
 * route can only patch what it can see, which excludes presets. It is deprecated in ts-jest and it is
 * still honoured in 29.4; a version that drops it turns this back into a hard failure, loudly, in the
 * stage that already fails without it.
 */
export function jestConfigShim(projectConfig: string | undefined, jestConfigPath = "jest-config"): string {
  return `// Generated by sidecrew (src/verifier/ts.ts) inside a sandbox — see ADR-0036.
// The project's own jest config, with ts-jest's diagnostics off so it stops type-checking Stryker's
// instrumentation. sidecrew type-checks the candidate in \`tsc --noEmit\` and the mutants in Stryker's
// own typescript checker, so nothing here is the only thing standing between a bad test and a verdict.
const { readInitialOptions } = require(${JSON.stringify(jestConfigPath)});

module.exports = async () => {
  const { config } = await readInitialOptions(${JSON.stringify(projectConfig)}, { skipMultipleConfigError: true });
  const globals = config.globals ?? {};
  return {
    ...config,
    globals: { ...globals, "ts-jest": { ...(globals["ts-jest"] ?? {}), diagnostics: false } },
  };
};
`;
}

/**
 * Jest config files, in the order Jest itself resolves them. `package.json`'s `jest` key is last and is
 * handled by absence: if none of these exist we pass no `configFile` and let Stryker's runner find it,
 * which is what it does correctly for that case.
 */
export const JEST_CONFIG_FILES = [
  "jest.config.js", "jest.config.cjs", "jest.config.mjs", "jest.config.ts", "jest.config.json",
] as const;

export const detectJestConfig = (projectDir: string): string | undefined =>
  JEST_CONFIG_FILES.find((name) => existsSync(join(projectDir, name)));

/**
 * The template. `fixtures/ts-fixture/stryker.config.mjs` is this text with the defaults, and
 * `test/verifier-ts.test.ts` fails if the two ever differ — the fixture is for a human running
 * `npx stryker run` by hand, and a config that drifts from the one the verifier uses would make that
 * debugging session answer a question nobody asked.
 */
export function strykerConfig(opts: StrykerConfigOpts = {}): string {
  const { tsconfig = "tsconfig.json", concurrency = DEFAULT_STRYKER_CONCURRENCY, mutate = ["src/**/*.ts"], timeoutMs = 10_000, runner = "vitest" } = opts;

  /**
   * Directories Stryker must not try to copy — see `symlinkedDirectories`. Emitted only when there are
   * any, so a project with none produces byte-identical output to every config written before ADR-0035,
   * which is what the fixture's checked-in copy asserts.
   */
  const ignore = (opts.ignorePatterns ?? []).length === 0 ? "" : `  // Symlinked directories: Stryker's own sandbox copy dies on them with ENOTSUP (ADR-0035).
  ignorePatterns: ${JSON.stringify(opts.ignorePatterns)},
`;

  /**
   * The default glob stays first, so any other plugin the project has still loads; the absolute paths
   * are added only where the glob cannot see them — see `strykerPluginPaths` (ADR-0036).
   */
  const plugins = (opts.plugins ?? []).length === 0 ? "" : `  // Stryker's plugin glob resolves against its own install directory, which under pnpm does not
  // contain the runner or the checker. Absolute paths are the one form it imports directly (ADR-0036).
  plugins: ${JSON.stringify(["@stryker-mutator/*", ...(opts.plugins ?? [])])},
`;

  /**
   * Jest needs its own block and vitest needs none (ADR-0028).
   *
   * `enableFindRelatedTests` is **off**, and that is the load-bearing line. On it, Stryker runs only the
   * tests jest thinks relate to the mutated file — a perf optimisation that is worth nothing here,
   * because ADR-0004's sandbox has exactly one test in it, and that is worth a great deal of risk: a
   * project whose module resolution jest cannot follow (path aliases, a monorepo, `jest-expo`) silently
   * relates the mutant to *no* tests, and every mutant comes back `NoCoverage`. That reads as "your test
   * covers nothing" when what happened is that jest could not find it.
   */
  const jest = runner !== "jest" ? "" : `  jest: {
    projectType: "custom",${opts.jestConfig === undefined ? "" : `\n    configFile: ${JSON.stringify(opts.jestConfig)},`}
    enableFindRelatedTests: false,
  },
`;

  return `// Generated by sidecrew (src/verifier/ts.ts). Scoped to one file — see ADR-0004.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: ${JSON.stringify(runner)},
${jest}${plugins}${ignore}  // The type checker is what keeps mutants that cannot compile out of the denominator: they are noise
  // about TypeScript, not evidence about the test. It only does that with disableTypeChecks off.
  checkers: ["typescript"],
  tsconfigFile: ${JSON.stringify(tsconfig)},
  disableTypeChecks: false,
  coverageAnalysis: "perTest",
  reporters: ["json"],
  jsonReporter: { fileName: ${JSON.stringify(MUTATION_REPORT)} },
  mutate: ${JSON.stringify(mutate)},
  // Safe only because the sandbox is per candidate, so this file is always cold. Pointed at a shared
  // location it silently hands one candidate the kills another candidate earned — measured, ADR-0004.
  incremental: true,
  incrementalFile: ".sidecrew-mutation/stryker-incremental.json",
  concurrency: ${concurrency},
  // A score is a signal for review, never a pass/fail — ADR-0006. Nothing here may fail the run.
  thresholds: { high: 80, low: 60, break: null },
  timeoutMS: ${timeoutMs},
  logLevel: "warn",
};
`;
}

// ── the mutation report ───────────────────────────────────────────────────────────────────────────

/** Statuses that say something about the test. Everything else is Stryker talking about itself. */
const COUNTED = new Set(["Killed", "Survived", "Timeout", "NoCoverage"]);

interface RawMutant { id?: unknown; status?: unknown }
interface RawReport { files?: Record<string, { mutants?: RawMutant[] }> }

/**
 * Stryker's `mutation.json` → the `MutationResult` in the contract.
 *
 * Two asymmetries, both deliberate. The **score** counts a timeout as a kill and a never-covered mutant
 * as a miss, which is the mutation-testing standard and keeps our numbers comparable with everybody
 * else's. **Survival** requires `killed ≥ 1` with `killed` meaning the `Killed` status alone: a mutant
 * that hung the suite is a mutant nothing asserted about, and one of those is not the evidence
 * CLAUDE.md #2 is asking for.
 */
export function parseMutationReport(report: unknown, sourceFile?: string): MutationResult {
  const files = (report as RawReport | null)?.files ?? {};
  const wanted = sourceFile === undefined ? null : sourceFile.split(sep).join("/");
  const keys = Object.keys(files);
  const matching = wanted === null ? keys : keys.filter((k) => k.split(sep).join("/").endsWith(wanted));
  // A report that names the file differently is still a report about the run we just did; counting
  // nothing would turn a naming difference into "this test killed nothing", which is a lie.
  const selected = matching.length > 0 ? matching : keys;

  const counts: Record<string, number> = { Killed: 0, Survived: 0, Timeout: 0, NoCoverage: 0 };
  const killed_ids: string[] = [];
  for (const key of selected) {
    for (const mutant of files[key]?.mutants ?? []) {
      const status = String(mutant.status);
      if (!COUNTED.has(status)) continue;
      counts[status] = (counts[status] ?? 0) + 1;
      if (status === "Killed") killed_ids.push(String(mutant.id));
    }
  }

  const killed = counts.Killed ?? 0;
  const survived = counts.Survived ?? 0;
  const timeout = counts.Timeout ?? 0;
  const no_coverage = counts.NoCoverage ?? 0;
  const denominator = killed + timeout + survived + no_coverage;
  const score = denominator === 0 ? 0 : (killed + timeout) / denominator;
  return MutationResult.parse({ score, killed, survived, timeout, no_coverage, killed_ids });
}

// ── the sandbox ───────────────────────────────────────────────────────────────────────────────────

/**
 * A copy of the project with its own tests left behind and its `node_modules` symlinked.
 *
 * Removing the tests is the part that matters (ADR-0004). Stryker attributes a kill to whatever test
 * killed it, but our verdict is a count, and a project with a real suite would hand every candidate a
 * full set of kills it had nothing to do with. What is left is "your project, with exactly one test in
 * it", which is the only configuration in which `killed ≥ 1` means what CLAUDE.md #2 says it means.
 */
export async function makeSandbox(projectDir: string, root?: string, nodeModules?: string): Promise<string> {
  const sandbox = await mkdtemp(join(root ?? tmpdir(), "sidecrew-ts-"));
  // Which test-named files the project's own code imports, and therefore cannot lose (ADR-0035).
  const rescued = await surveyTestNames(projectDir);
  await cp(projectDir, sandbox, {
    recursive: true,
    filter: (src) => {
      const rel = relative(projectDir, src);
      if (rel.length === 0) return true;
      if (skipFromSandbox(rel)) return false;
      if (!TEST_FILE_PATTERN.test(basename(src))) return true;
      return rescued.has(rel);
    },
  });
  // Symlinked, still, and upgraded to a real copy only when TypeScript proves it has to be (ADR-0034).
  // See `cloneNodeModules` for why the upgrade exists and why it is not the default.
  const modules = nodeModules ?? resolveNodeModules(projectDir);
  if (modules !== null) await symlink(modules, join(sandbox, "node_modules"), "dir");
  return sandbox;
}

/**
 * TypeScript refusing to name a type because `node_modules` is a symlink out of the sandbox.
 *
 * ```
 * error TS2883: The inferred type of 'getWinstonConfig' cannot be named without a reference to
 * '../../../../../../../../../../Users/…/node_modules/logform'. This is likely not portable.
 * ```
 *
 * It is about the *project's own* code, never about the candidate, and it fires on every candidate of an
 * affected project — so untreated it is a 0 % survival rate reported as twenty compile failures.
 */
const TS_SYMLINK_ERROR = /\bTS2883\b/;

/**
 * Replace the sandbox's symlinked `node_modules` with a real copy-on-write clone.
 *
 * ADR-0004 symlinked, reasoning that "a 200 MB copy per candidate would cost more than the mutation run".
 * On a real project that is **false** — an APFS clone took 18 s against a 104 s mutation stage — but on
 * the fixtures it is **true**: cloning doubled a verdict, 10.9 s to 17.5 s, because their mutation stage
 * is only 6 s. Both measurements are right about their own project, so neither can be the rule.
 *
 * Hence: symlink first, clone only when `tsc` has actually produced TS2883. A project that does not trip
 * it pays nothing; a project that does pays one extra compile and then works, instead of scoring zero.
 */
async function cloneNodeModules(from: string, to: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  await rm(to, { recursive: true, force: true });
  // `-c` is the clone flag: on APFS it shares blocks, so this is cheap in space and close to cheap in
  // time. Anywhere it is unavailable the symlink goes back and the verdict stands as it was.
  const cloned = await run("cp", ["-Rc", from, to], { timeoutMs: 300_000 });
  if (cloned.code === 0) return true;
  await symlink(from, to, "dir");
  return false;
}

/** The project's own binary, never a downloaded one: `--no-install` is the fallback's whole point. */
export const binary = (projectDir: string, name: string): { cmd: string; args: string[] } => {
  const local = join(projectDir, "node_modules", ".bin", name);
  return existsSync(local) ? { cmd: local, args: [] } : { cmd: "npx", args: ["--no-install", name] };
};

/**
 * `CI` is set for a reason that is not about continuous integration: it stops vitest writing a
 * snapshot file for a snapshot that does not exist yet. Without it, a candidate whose only assertion
 * is `toMatchSnapshot()` records its own answer and passes — the verifier would be blessing the
 * output instead of checking it.
 */
export const STAGE_ENV = { CI: "true", NO_COLOR: "1", FORCE_COLOR: "0" } as const;

/**
 * The environment a **project's own toolchain** is run in, and the reason it is a function.
 *
 * `STAGE_ENV` says what to add. This says what to take away, and Phase 11 is what it cost to learn
 * that the second half matters as much as the first.
 *
 * Run sidecrew through a package-manager wrapper — `npx sidecrew fix`, an npm script, `npx tsx` — and
 * npm exports its own state into the environment: `npm_config_cache`, `npm_config_prefix`, `INIT_CWD`,
 * `NODE`, a dozen `npm_package_*`. Those variables are inherited by every child, including the
 * project's test runner, and a dependency that resolves a cache directory from them then resolves a
 * **different** one. Measured on a real Nest project: `mongodb-memory-server` looked for its cached
 * `mongod` where npm pointed rather than where the project had put it, failed an MD5 check on what it
 * found, and took every suite that needs an in-memory Mongo down with it — 3,931 tests, about 170
 * suites, reported as ordinary test failures.
 *
 * That is the workload-#2a form of ADR-0037 and it is worse than the original: the failures land in
 * the **baseline**, so the gate does not break, it quietly gets weaker. Only the tests that survived
 * the contamination have to keep passing afterwards, and no field in the verdict says so.
 *
 * So the project's toolchain runs in an environment the launcher cannot reach into. `undefined`
 * removes a variable (`src/exec.ts`), and the list is "what a package manager exports", not a
 * denylist of things observed to break — the next dependency to read `npm_config_cache` should not
 * cost another night.
 */
export const stageEnv = (parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...STAGE_ENV };
  for (const key of Object.keys(parent)) {
    if (/^npm_/i.test(key)) env[key] = undefined;
  }
  for (const key of ["INIT_CWD", "NODE", "COLOR", "npm_config_cache", "npm_config_prefix"]) {
    env[key] = undefined;
  }
  return env;
};

/**
 * How each runner is asked to run exactly one file, and why each flag is there.
 *
 * **vitest**: `run <file>` is positional and matched against the project's `include`, which the fixture
 * satisfies by construction.
 *
 * **jest**: `--runTestsByPath` takes the path literally instead of matching it against `testMatch`.
 * That is the difference between working on any project and working on projects whose `testMatch`
 * happens to cover wherever we put the candidate — a `jest-expo` preset matches any `.test.ts` anywhere,
 * a Nest app matches `.spec.ts` under `src/`, and a candidate written to `test/` satisfies one and not
 * the other.
 * `--ci` refuses to write a snapshot that does not exist yet, which is the same cheap pass `CI=true`
 * closes for vitest (ADR-0006) and is worth stating twice. There is deliberately **no**
 * `--passWithNoTests`: a run that executed nothing must fail, which is ADR-0006's Swift lesson — `swift
 * test` exits 0 on an empty suite and jest would too if asked nicely.
 */
export const runArgs = (runner: TestRunner, testFile: string): string[] =>
  runner === "jest"
    ? ["--ci", "--runTestsByPath", testFile]
    : ["run", testFile];

// ── the verifier ──────────────────────────────────────────────────────────────────────────────────

/**
 * `NODE_OPTIONS` already reaches every stage — `exec.run` merges the parent environment — so the fix is
 * something the caller can do today. What was missing is anything telling them to.
 */
const assertNotOutOfMemory = (text: string, what: string, projectDir: string): void => {
  if (!looksLikeOom(text)) return;
  throw new VerifierSetupError(
    `${what} ran out of memory on ${projectDir}, which is a limit on this machine rather than anything ` +
    "about the candidate.\n" +
    "  Give it more heap and run again — sidecrew passes the environment through:\n" +
    "    NODE_OPTIONS=--max-old-space-size=8192 sidecrew run <plan>\n" +
    "  A large project usually already knows the number it needs; look for NODE_OPTIONS in its own " +
    "typecheck or test script.",
  );
};

const mutateArg = (file: string, range: readonly [number, number] | null): string =>
  range ? `${file.split(sep).join("/")}:${range[0]}-${range[1]}` : file.split(sep).join("/");

/**
 * Verify one candidate against one function. Returns a `Verdict`; throws only when the machine cannot
 * run the pipeline at all, because "your toolchain is missing" and "your test is bad" must never
 * arrive at the retry loop wearing the same clothes.
 */
export async function verifyTs(candidate: Candidate, opts: VerifyTsOpts): Promise<Verdict> {
  const target = opts.target;
  const projectDir = resolve(target.projectDir);
  const tsconfig = target.tsconfig ?? "tsconfig.json";
  const timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  const testFile = target.testFile ?? `test/${safeName(candidate.task_id)}.test.ts`;
  const runner = target.runner ?? "vitest";
  const jestConfig = runner === "jest" ? target.jestConfig ?? detectJestConfig(projectDir) : undefined;

  for (const [what, path] of [["a package.json", "package.json"], [tsconfig, tsconfig], [target.sourceFile, target.sourceFile]] as const) {
    if (!existsSync(join(projectDir, path))) throw new VerifierSetupError(`${projectDir} has no ${what}`);
  }

  // Walked up to, not required in place (ADR-0029). A workspace package in a hoisted monorepo has its
  // dependencies at the repo root and no `node_modules` of its own, and demanding one there made every
  // monorepo unverifiable — which is how the first real project this met was refused at step one.
  const nodeModules = resolveNodeModules(projectDir);
  if (nodeModules === null) {
    throw new VerifierSetupError(`no node_modules at or above ${projectDir} — run npm i`);
  }

  // Stryker's runner plugins are separate packages, and the failure without one is a Stryker error
  // several minutes into a mutation run rather than anything about the candidate. Checked here, where
  // it is a setup error and the retry loop will not spend an attempt on it.
  const plugin = STRYKER_PLUGIN[runner];
  if (!isResolvable(plugin, projectDir)) {
    throw new VerifierSetupError(
      `${plugin} is not resolvable from ${projectDir}, and Stryker needs it to drive ${runner} — npm i -D ${plugin}`,
    );
  }

  // Free, and the most useful thing the retry can be told, so it is computed before anything is spawned.
  const tautology = analyseTautology(candidate.test_source, target.functionName, { exemplar: target.exemplar });

  const timing_ms: { compile?: number; pass?: number; mutation?: number } = {};
  const problems: string[] = [];
  if (tautology.tautological) problems.push(tautologyMessage(tautology, target.functionName));

  const sandbox = await makeSandbox(projectDir, opts.sandboxRoot, nodeModules);
  let compile_ok = false;
  let pass_ok = false;
  let mutation: MutationResult | null = null;
  let stage_reached: Stage = "compile";

  try {
    const candidatePath = join(sandbox, testFile);
    await mkdir(dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, candidate.test_source, "utf8");

    const tsc = binary(projectDir, "tsc");
    // `--listFiles` is what makes the stage able to prove it did its job (ADR-0037). It is free: the
    // same invocation, with the program's file list on stdout.
    const typecheck = async (project: string): ReturnType<typeof run> =>
      run(tsc.cmd, [...tsc.args, "--noEmit", "--listFiles", "-p", project], {
        cwd: sandbox, timeoutMs: timeouts.compile, env: stageEnv(),
      });
    // Whether this project needs widening is a property of the project, not of the candidate, so it is
    // learnt once and reused. Without this every candidate pays two `tsc` runs — measured on a real
    // React project at ~40 s each, which is the whole compile stage doubled for every attempt in a run.
    const widenKey = `${projectDir}\u0000${tsconfig}\u0000${dirname(testFile)}`;
    const writeDerived = async (): Promise<void> => {
      await writeFile(join(sandbox, SIDECREW_TSCONFIG), derivedTsconfig(tsconfig, testFile), "utf8");
    };
    let project = tsconfig;
    if (NEEDS_WIDENING.get(widenKey) === true) {
      await writeDerived();
      project = SIDECREW_TSCONFIG;
    }
    let compile = await typecheck(project);

    // One retry, and only for the one error that is about our sandbox rather than about the candidate
    // (ADR-0034). If the clone is unavailable the symlink goes back and the original verdict stands.
    if (compile.code !== 0 && TS_SYMLINK_ERROR.test(output(compile)) && nodeModules !== null) {
      if (await cloneNodeModules(nodeModules, join(sandbox, "node_modules"))) {
        const before = compile.ms;
        compile = await typecheck(project);
        compile.ms += before;
      }
    }

    // The second thing the stage has to prove, and the one it used to get wrong in silence: that the
    // candidate was in the program at all (ADR-0037). Same shape as the TS2883 clone above — notice,
    // widen the scope by one file, check again — because a project whose `include` does not cover the
    // test directory is a fact about the project, not about the candidate.
    //
    // Only when the run *succeeded*. A failed run is already a verdict, and widening would re-run `tsc`
    // to produce the same project errors for no information.
    let checked = typecheckedCandidate(compile, sandbox, testFile);
    if (compile.code === 0 && !checked && project === tsconfig) {
      NEEDS_WIDENING.set(widenKey, true);
      const before = compile.ms;
      await writeDerived();
      project = SIDECREW_TSCONFIG;
      compile = await typecheck(project);
      compile.ms += before;
      checked = typecheckedCandidate(compile, sandbox, testFile);
    } else if (compile.code === 0 && checked && project === tsconfig) {
      NEEDS_WIDENING.set(widenKey, false);
    }

    if (compile.code === 0 && !checked) {
      // Never seen; it is here because the alternative to failing loudly is passing quietly, and
      // this whole ADR exists because the stage did the second one.
      throw new VerifierSetupError(
        `tsc did not type-check the candidate (${testFile}) under ${tsconfig} or ${SIDECREW_TSCONFIG}. ` +
        "The compile stage cannot be relied on for this project — see ADR-0037.",
      );
    }

    timing_ms.compile = compile.ms;
    compile_ok = compile.code === 0;
    if (!compile_ok) {
      // A machine problem wearing a compiler error's clothes (ADR-0032). Thrown rather than returned, so
      // the retry rule never spends an attempt on it and the message names the fix instead of the file.
      const said = stripFileList(output(compile));
      assertNotOutOfMemory(said, "tsc --noEmit", projectDir);
      // Errors from a program the candidate is not in are about the project, and calling them "did not
      // compile" is the lie ADR-0033 was written about. Say so rather than letting the retry read them
      // as the candidate's (ADR-0037).
      const whose = checked
        ? ""
        : `\nNone of this is about the candidate: tsc did not have ${testFile} in the program.`;
      problems.push(`tsc --noEmit failed:\n${said}${whose}`);
    }

    if (compile_ok) {
      stage_reached = "pass";
      const bin = binary(projectDir, runner);
      const args = runArgs(runner, testFile);
      const passed = await run(bin.cmd, [...bin.args, ...args], {
        cwd: sandbox, timeoutMs: timeouts.pass, env: stageEnv(),
      });
      timing_ms.pass = passed.ms;
      pass_ok = passed.code === 0;
      if (!pass_ok) {
        assertNotOutOfMemory(output(passed), `${runner} ${args.join(" ")}`, projectDir);
        problems.push(`${runner} ${args.join(" ")} failed:\n${output(passed)}`);
      }
    }

    // Skipped when the verdict is already settled. Mutation is ~90 % of the cost of a candidate, and a
    // test that does not compile, does not pass, or asserts nothing cannot be rescued by running it.
    if (compile_ok && pass_ok && !tautology.tautological) {
      stage_reached = "mutation";
      const ignorePatterns = await symlinkedDirectories(sandbox);
      // ts-jest type-checking Stryker's instrumentation is the one thing that stops a stock NestJS
      // project being mutated at all (ADR-0036). The shim only exists where it can: ts-jest has to be
      // what the project uses, and `jest-config` has to be resolvable for the shim to read the config
      // it is wrapping. Where either is false, the config below is exactly what it was.
      const jestConfigPath = runner === "jest" && isResolvable("ts-jest", projectDir) ? jestConfigEntry(projectDir) : null;
      const shim = jestConfigPath !== null;
      if (shim) await writeFile(join(sandbox, SIDECREW_JEST_CONFIG), jestConfigShim(jestConfig, jestConfigPath), "utf8");
      await writeFile(join(sandbox, STRYKER_CONFIG), strykerConfig({
        tsconfig, concurrency: opts.concurrency, runner,
        jestConfig: shim ? SIDECREW_JEST_CONFIG : jestConfig,
        ignorePatterns,
        plugins: strykerPluginPaths(projectDir, runner),
      }), "utf8");
      const stryker = binary(projectDir, "stryker");
      const range = target.lineRange === undefined
        ? deriveLineRange(
          await readFile(join(projectDir, target.sourceFile), "utf8"), target.functionName, "typescript",
          { projectDir, fileName: target.sourceFile },
        )
        : target.lineRange;
      // The config file is a positional argument, and it has to come last: `stryker run --mutate X cfg`.
      const mutated = await run(stryker.cmd, [...stryker.args, "run", "--mutate", mutateArg(target.sourceFile, range), STRYKER_CONFIG], {
        cwd: sandbox, timeoutMs: timeouts.mutation, env: stageEnv(),
      });
      timing_ms.mutation = mutated.ms;
      const report = await readReport(join(sandbox, MUTATION_REPORT));
      if (report === null) {
        // The mutation run itself broke. `stage_reached` says so, because escalating this candidate as
        // though its test were at fault would retry a machine problem at the worker's expense.
        const said = output(mutated);
        // Naming the cause rather than handing over a page of errors about code nobody wrote. This is
        // reachable when the ts-jest shim could not be written — see `jestConfigEntry` (ADR-0038).
        const why = TS_JEST_INSTRUMENTATION.test(said)
          ? "\nThis is ts-jest type-checking Stryker's instrumentation, not a fault in the test. sidecrew " +
            `could not disable it: ${shim ? "the shim was written and did not take effect" : "jest-config was not resolvable from this project"}. ` +
            "Set `diagnostics: false` on the project's ts-jest transform — see ADR-0036."
          : "";
        problems.push(`stryker produced no ${MUTATION_REPORT}:\n${said}${why}`);
      } else {
        stage_reached = "done";
        mutation = parseMutationReport(report, target.sourceFile);
        if (mutation.killed === 0) {
          problems.push(
            `no mutant of ${target.functionName} was killed: ${mutation.survived} survived, ` +
            `${mutation.no_coverage} were never reached, ${mutation.timeout} timed out. ` +
            `The test passes against the original code and against every changed version of it.`,
          );
        }
      }
    }
  } finally {
    if (opts.keepSandbox) process.stderr.write(`sidecrew: sandbox kept at ${sandbox}\n`);
    else await rm(sandbox, { recursive: true, force: true });
  }

  const fields = {
    task_id: candidate.task_id,
    stage_reached,
    compile_ok,
    pass_ok,
    tautological: tautology.tautological,
    mutation,
    error: problems.length > 0 ? truncateError(problems.join("\n\n")) : null,
    timing_ms,
  };
  return Verdict.parse({ ...fields, survived: survives({ ...fields, survived: false }) });
}

const tautologyMessage = (report: TautologyReport, fn: string): string =>
  `tautological — it passes without testing ${fn}:\n` +
  report.findings.map((f) => `  line ${f.line}: ${f.message}`).join("\n");

const readReport = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
};
