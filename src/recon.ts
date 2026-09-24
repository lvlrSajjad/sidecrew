// `sidecrew recon` — ADR-0079 option A, and piece 1 of ADR-0090 §4.
//
// *"Your own config reports 0 errors; under `--strictNullChecks` you have 763 — do you want to see
// them?"* That sentence, as a command. It runs the project's own `tsc` once under its own configuration
// and once per strictness flag, in a sandbox copy, and reports what each flag would add, split into
// source files and test files.
//
// **It is a predicate report, which is why it needs no relevance oracle** (ADR-0090 §2.1): the user
// asked *how many*, and every number is the compiler's own. No worker runs and nothing here is a model's
// opinion.
//
// **It counts; it does not offer.** PHASES.md 14d: *"a report that quantifies work the gate cannot then
// deliver is worse than no report"*. `ReconReport.fix_offered` is the literal `false`, so a report that
// offers does not serialise.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertChangeToolchain, DEFAULT_CHANGE_TIMEOUTS, makeChangeSandbox, PROJECT_SCOPE, typecheck } from "./change.js";
import { isTestArtefact } from "./confinement.js";
import { run } from "./exec.js";
import { withIntactProject } from "./integrity.js";
import { ReconReport, type ReconFlag, type ReconSplit, type StrictnessFlag } from "./schemas.js";
import { removeSandbox, resolveNodeModules } from "./verifier/shared.js";
import { binary, stageEnv } from "./verifier/ts.js";

/**
 * The flags a recon runs when none are named. The two that decide a strictness migration
 * (`strictNullChecks`, `noImplicitAny`), and the three whose fixes delete or add a line rather than
 * narrow a type — the lint-shaped ones ADR-0079 singles out as the raised bar the gate can already
 * credit. `--strict` is left out: it is the others at once, and one more full compile to say so.
 */
export const DEFAULT_RECON_FLAGS: readonly StrictnessFlag[] = [
  "--strictNullChecks",
  "--noImplicitAny",
  "--noImplicitReturns",
  "--noUnusedLocals",
  "--noUnusedParameters",
];

export const DEFAULT_RECON_TOP = 10;

/** What `--strict` turns on, for a compiler whose `--showConfig` does not spell the family out. */
const STRICT_FAMILY = new Set([
  "strictNullChecks", "strictFunctionTypes", "strictBindCallApply", "strictPropertyInitialization",
  "noImplicitAny", "noImplicitThis", "useUnknownInCatchVariables",
]);

/** Is `flag` already on in a resolved `compilerOptions`? An explicit `false` beats `strict`, as it does in tsc. */
export function isEnabled(options: Record<string, unknown>, flag: StrictnessFlag): boolean {
  const name = flag.slice(2);
  if (options[name] === true) return true;
  if (options[name] === false) return false;
  return options.strict === true && STRICT_FAMILY.has(name);
}

/** `tsc --showConfig`'s `compilerOptions`, or null when the compiler would not say. */
export function parseShowConfig(stdout: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stdout) as { compilerOptions?: unknown };
    const options = parsed.compilerOptions;
    return options !== null && typeof options === "object" ? (options as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const CODE = /\berror (TS\d+)\b/;

/** How many of each `TSnnnn` a compile reported. */
export function countCodes(message: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of message.split("\n")) {
    const m = CODE.exec(line);
    if (m) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  return counts;
}

const topCodes = (counts: Map<string, number>, top: number) =>
  [...counts].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top).map(([code, count]) => ({ code, count }));

/** One compile, reduced to what a finding is computed from. */
export interface Compile {
  by_file: Record<string, number>;
  codes: Map<string, number>;
}

/** Split a per-file count into source and test files, and the errors that belong to no file. */
export function split(byFile: Record<string, number>): { source: ReconSplit; tests: ReconSplit; config: number } {
  const source = { errors: 0, files: 0 };
  const tests = { errors: 0, files: 0 };
  let config = 0;
  for (const [file, n] of Object.entries(byFile)) {
    if (n <= 0) continue;
    if (file === PROJECT_SCOPE) { config += n; continue; }
    const side = isTestArtefact(file) ? tests : source;
    side.errors += n;
    side.files += 1;
  }
  return { source, tests, config };
}

/**
 * What `under` adds over `base`, per file and never negative.
 *
 * Per file rather than as a difference of totals, because a stricter compiler can report a *different*
 * error at a site it already complained about, and a total would let a file that lost one and a file
 * that gained one cancel. What the user is asking is *how much new work*, and that is the positive part.
 */
export function flagFinding(flag: StrictnessFlag, base: Compile, under: Compile, top: number, ms: number): ReconFlag {
  const added: Record<string, number> = {};
  for (const [file, n] of Object.entries(under.by_file)) {
    const d = n - (base.by_file[file] ?? 0);
    if (d > 0) added[file] = d;
  }
  const codes = new Map<string, number>();
  for (const [code, n] of under.codes) codes.set(code, n - (base.codes.get(code) ?? 0));
  const { source, tests, config } = split(added);
  const top_files = Object.entries(added)
    .filter(([file]) => file !== PROJECT_SCOPE)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([file, errors]) => ({ file, errors, test: isTestArtefact(file) }));
  return {
    flag, already_on: false,
    added: source.errors + tests.errors + config,
    source, tests, config_errors: config,
    top_files, top_codes: topCodes(codes, 5), ms,
  };
}

export const alreadyOn = (flag: StrictnessFlag): ReconFlag => ({
  flag, already_on: true, added: null, source: null, tests: null, config_errors: null, top_files: [], top_codes: [], ms: 0,
});

/** The project's own TypeScript version, which is the compiler every number here is from. */
const typescriptVersion = (projectDir: string): string | null => {
  const modules = resolveNodeModules(projectDir);
  const pkg = modules === null ? null : join(modules, "typescript", "package.json");
  if (pkg === null || !existsSync(pkg)) return null;
  try {
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
};

export const RECON_NOTE =
  "A count, not an offer. sidecrew does not yet fix the errors a strictness flag adds: the usual fix " +
  "narrows a type, the narrowed type reaches test files, and a behaviour-preserving task may not edit " +
  "tests because the tests are the gate — measured at 2/30 under --strictNullChecks (ADR-0077). Ask " +
  "for more of a flag's files with --flags <flag> --top <n>.";

export interface ReconOpts {
  tsconfig?: string;
  flags?: readonly StrictnessFlag[];
  top?: number;
  /** Per compile. A large project under a strict flag is minutes, not seconds. */
  timeoutMs?: number;
  sandboxRoot?: string;
  onEvent?: (line: string) => void;
}

export async function recon(projectDir: string, opts: ReconOpts = {}): Promise<ReconReport> {
  const tsconfig = opts.tsconfig ?? "tsconfig.json";
  const flags = [...new Set(opts.flags ?? DEFAULT_RECON_FLAGS)];
  const top = opts.top ?? DEFAULT_RECON_TOP;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHANGE_TIMEOUTS.compile;
  const say = opts.onEvent ?? (() => {});
  assertChangeToolchain(projectDir, tsconfig);

  // ADR-0088: a project is intact after every job, and this one is checked like `run` and `fix` are.
  // `tsc --noEmit` writes nothing — unless the tsconfig is `incremental`, when it writes a
  // `.tsbuildinfo` — which is why it runs in a sandbox and not in the project.
  return withIntactProject(projectDir, async () => {
    const sandbox = await makeChangeSandbox(projectDir, opts.sandboxRoot);
    try {
      const tsc = binary(resolve(projectDir), "tsc");
      const shown = await run(tsc.cmd, [...tsc.args, "-p", tsconfig, "--showConfig"], {
        cwd: sandbox, timeoutMs: 60_000, env: stageEnv(), maxOutputBytes: 16 << 20,
      });
      const options = shown.code === 0 ? parseShowConfig(shown.stdout) : null;

      say(`  tsc under ${tsconfig} as the project has it`);
      const base = await typecheck(sandbox, projectDir, tsconfig, timeoutMs);
      const baseCompile: Compile = { by_file: base.errors.by_file, codes: countCodes(base.message) };
      const baseSplit = split(base.errors.by_file);
      const testsInProgram = [...base.program].filter((f) => isTestArtefact(f)).length;

      const findings: ReconFlag[] = [];
      for (const flag of flags) {
        if (options !== null && isEnabled(options, flag)) {
          say(`  ${flag}: already on in ${tsconfig}`);
          findings.push(alreadyOn(flag));
          continue;
        }
        say(`  tsc under ${tsconfig} + ${flag}`);
        const under = await typecheck(sandbox, projectDir, tsconfig, timeoutMs, [flag]);
        findings.push(flagFinding(flag, baseCompile, { by_file: under.errors.by_file, codes: countCodes(under.message) }, top, under.ms));
      }

      const head = await run("git", ["-C", resolve(projectDir), "rev-parse", "HEAD"], { timeoutMs: 30_000 });
      return ReconReport.parse({
        version: 1,
        project: projectDir,
        tsconfig,
        commit: head.code === 0 ? head.stdout.trim() : null,
        typescript: typescriptVersion(resolve(projectDir)),
        created: new Date().toISOString(),
        config_read: options !== null,
        baseline: {
          errors: base.errors.total,
          source: baseSplit.source,
          tests: baseSplit.tests,
          config_errors: baseSplit.config,
          program_files: base.program.size,
          tests_in_program: testsInProgram,
          top_codes: topCodes(baseCompile.codes, 5),
          ms: base.ms,
        },
        flags: findings,
        fix_offered: false,
        note: RECON_NOTE,
      });
    } finally {
      await removeSandbox(sandbox);
    }
  }, say);
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const splitText = (s: ReconSplit): string => `${plural(s.errors, "error")} in ${plural(s.files, "file")}`;

/** The report as a person reads it. The JSON is the contract; this is the sentence ADR-0079 asked for. */
export function renderRecon(r: ReconReport): string {
  const b = r.baseline;
  const out = [
    `sidecrew recon — ${r.project} (${r.tsconfig}${r.typescript ? `, TypeScript ${r.typescript}` : ""}${r.commit ? `, at ${r.commit.slice(0, 10)}` : ""})`,
    "",
    `  your own configuration   ${plural(b.errors, "error")}` +
      (b.errors > 0 ? ` — source: ${splitText(b.source)} · tests: ${splitText(b.tests)}` : "") +
      (b.config_errors > 0 ? ` · ${b.config_errors} against no file` : ""),
    `                           ${plural(b.program_files, "file")} in the program, ${b.tests_in_program} of them tests`,
  ];
  for (const f of r.flags) {
    const label = `  + ${f.flag}`.padEnd(27);
    if (f.already_on) {
      out.push(`${label}already on in ${r.tsconfig}`);
      continue;
    }
    out.push(`${label}+${plural(f.added ?? 0, "error")}` + (f.added ? ` — source: ${splitText(f.source!)} · tests: ${splitText(f.tests!)}` : ""));
    if (f.config_errors) out.push(`${"".padEnd(27)}${f.config_errors} against no file — the project's compiler may reject this flag`);
    if (f.top_codes.length > 0) out.push(`${"".padEnd(27)}most common: ${f.top_codes.map((c) => `${c.code} ×${c.count}`).join(", ")}`);
    for (const file of f.top_files) out.push(`${"".padEnd(29)}${String(file.errors).padStart(5)}  ${file.file}${file.test ? "  (test)" : ""}`);
  }
  if (!r.config_read) out.push("", "  tsc --showConfig did not answer, so every flag was run — one the project already has reports +0.");
  out.push("", `  ${r.note}`);
  return `${out.join("\n")}\n`;
}

export async function reconCommand(opts: ReconOpts & { project: string; json?: boolean }): Promise<ReconReport> {
  const report = await recon(opts.project, { ...opts, onEvent: opts.json ? undefined : (l) => process.stderr.write(`${l}\n`) });
  process.stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderRecon(report));
  return report;
}
