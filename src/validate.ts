// `sidecrew plan --validate` / `sidecrew_plan_validate` — is this plan one a run may spend tokens on?
//
// Everything here already exists somewhere: `loadPlan` resolves a plan, `staleFunctions` hashes it,
// `verifyCandidate` verifies a candidate, `testTargets` lists a package's targets. What this file adds
// is that it **reports instead of throwing**. `loadPlan` stops at the first problem with a sentence,
// which is right for a run that is about to do work and wrong for a planner that wants the whole list
// before it edits. So the checks are re-walked in an order that never short-circuits on anything it
// can survive, and each failure becomes a `ValidationIssue` with a code a caller can branch on.
//
// Two of the rules here are the ones that pay for the file:
//
//   * **An exemplar is only an exemplar if it survives.** The worker copies it structurally, so an
//     exemplar that does not compile teaches twenty candidates not to compile. It is verified for
//     real, through the same verifier, and that is why `verify_exemplars` costs seconds per shape.
//   * **Staleness is a warning, not an error.** A plan whose code moved under it is still a
//     well-formed plan; it is `runBatch` — the thing about to spend the tokens — that refuses. A
//     validator that failed on it would make `--validate` a second, weaker copy of that check instead
//     of a description of the plan.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  findProjectRoot,
  functionOfTaskId,
  sliceLines,
  sourceSha,
  taskId,
  verifyCandidate,
  type LoadedPlan,
} from "./plan.js";
import { Candidate, MAX_SHAPES_PER_FUNCTION, TestPlan, ValidationReport, type ShapeKind, type ValidationIssue } from "./schemas.js";
import { deriveLineRange } from "./verifier/shared.js";
import { testTargets } from "./verifier/swift.js";

export interface ValidateOpts {
  /**
   * Run every exemplar through the verifier. Default true, and it is what makes the report mean
   * something; false is the fast structural pass, and the report warns that it was used.
   */
  verifyExemplars?: boolean;
  /** Passed through to the TypeScript verifier, as `runBatch` passes it. */
  concurrency?: number;
  /** ADR-0014's override, so validating with `--test-target` matches how the run will be invoked. */
  testTarget?: string;
  /** One line per exemplar verified. Exemplar verification is slow enough to need a progress report. */
  onEvent?: (line: string) => void;
}

const issue = (code: string, message: string, where: string): ValidationIssue => ({ code, message, where });

/** A report that got no further than the file itself. `checked` counts what was checked, so: nothing. */
const stillborn = (plan: string, e: ValidationIssue): ValidationReport => ValidationReport.parse({
  plan,
  valid: false,
  checked: { functions: 0, shapes: 0, exemplars: 0 },
  errors: [e],
  warnings: [],
  stale: [],
});

/**
 * `module`, resolved the way `loadPlan` resolves it — against the cwd first and the plan's own
 * directory second — but answering `null` instead of throwing.
 */
const findModule = (moduleField: string, planPath: string): string | null =>
  [resolve(moduleField), resolve(dirname(planPath), moduleField)].find((p) => existsSync(p)) ?? null;

export async function validatePlan(planPath: string, opts: ValidateOpts = {}): Promise<ValidationReport> {
  const say = opts.onEvent ?? (() => {});
  const abs = resolve(planPath);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(abs, "utf8")) as unknown;
  } catch (e) {
    return stillborn(abs, issue("unreadable_plan", `${planPath} is not readable JSON: ${String((e as Error).message)}`, ""));
  }

  const parsed = TestPlan.safeParse(raw);
  if (!parsed.success) {
    // Every issue, not the first: a planner fixing a plan wants the list, and zod already computed it.
    return ValidationReport.parse({
      plan: abs,
      valid: false,
      checked: { functions: 0, shapes: 0, exemplars: 0 },
      errors: parsed.error.issues.map((i) => {
        const where = i.path.join(".");
        const hint = where.endsWith("shapes") && i.code === "too_big"
          ? ` — the taxonomy allows at most ${MAX_SHAPES_PER_FUNCTION} shapes per function`
          : "";
        return issue("schema", `${where || "(root)"}: ${i.message}${hint}`, where);
      }),
      warnings: [],
      stale: [],
    });
  }
  const plan = parsed.data;

  // ── the module ────────────────────────────────────────────────────────────────────────────────
  const modulePath = findModule(plan.module, abs);
  if (modulePath === null) {
    return ValidationReport.parse({
      plan: abs,
      valid: false,
      checked: { functions: 0, shapes: plan.shapes.length, exemplars: 0 },
      errors: [issue("missing_module", `module ${plan.module} is not on disk, relative to the working directory or to ${abs}`, "module")],
      warnings: [],
      stale: [],
    });
  }
  const source = await readFile(modulePath, "utf8");
  const lines = source.split("\n").length;
  const dialect = plan.language === "swift" ? "swift" : "typescript";
  // Where to resolve the project's own `typescript` from, for AST-derived line ranges (ADR-0076). The
  // block below computes the same root again and reports the failure; here a failure is not an error,
  // because a module outside any project still has line ranges and they are still worth checking.
  const tsRoot = ((): string | undefined => {
    try {
      return findProjectRoot(modulePath, plan.language);
    } catch {
      return undefined;
    }
  })();

  // ── shapes ────────────────────────────────────────────────────────────────────────────────────
  const defined = new Set<ShapeKind>();
  const exemplarPaths = new Map<ShapeKind, string>();
  plan.shapes.forEach((shape, i) => {
    const where = `shapes[${i}]`;
    if (defined.has(shape.kind)) {
      errors.push(issue("duplicate_shape", `shapes[] defines ${shape.kind} twice — a function asking for it would get whichever came first`, `${where}.kind`));
    }
    defined.add(shape.kind);

    const path = resolve(dirname(abs), shape.exemplar);
    if (existsSync(path)) exemplarPaths.set(shape.kind, path);
    else errors.push(issue("missing_exemplar", `${shape.exemplar} does not exist on disk (resolved to ${path})`, `${where}.exemplar`));
  });

  // ── functions ─────────────────────────────────────────────────────────────────────────────────
  const seen = new Set<string>();
  const stale: string[] = [];
  plan.functions.forEach((fn, i) => {
    const where = `functions[${i}]`;
    if (seen.has(fn.name)) {
      errors.push(issue("duplicate_function", `functions[] lists ${fn.name} twice`, `${where}.name`));
    }
    seen.add(fn.name);

    for (const kind of fn.shapes) {
      if (!defined.has(kind)) {
        errors.push(issue("undefined_shape", `${fn.name} asks for shape ${kind}, which shapes[] does not define — the run would refuse this task`, `${where}.shapes`));
      }
    }

    const [from, to] = fn.line_range;
    if (from < 1 || to < from || to > lines) {
      errors.push(issue("bad_line_range", `${fn.name}'s line_range [${from}, ${to}] is not a range inside ${plan.module}, which has ${lines} lines`, `${where}.line_range`));
      return; // everything below reads the slice, and there isn't one
    }

    // A range that does not start at the declaration mutates lines belonging to something else
    // (ADR-0013). `deriveLineRange` finds only the declaration forms it knows, so finding nothing is
    // not evidence of anything and says nothing.
    const derived = deriveLineRange(source, fn.name, dialect, { projectDir: tsRoot, fileName: modulePath });
    if (derived !== null && (from > derived[0] || to < derived[1])) {
      errors.push(issue(
        "range_not_function",
        `${fn.name}'s line_range [${from}, ${to}] does not contain its declaration, which is at [${derived[0]}, ${derived[1]}] — mutation is scoped to this range (ADR-0013)`,
        `${where}.line_range`,
      ));
    }

    if (sourceSha(sliceLines(source, fn.line_range)) !== fn.source_sha) {
      stale.push(fn.name);
      warnings.push(issue("stale_source_sha", `${fn.name} has changed since the plan was written — a run will refuse this plan until it is re-planned`, where));
    }
  });

  const asked = new Set(plan.functions.flatMap((f) => f.shapes));
  for (const [i, shape] of plan.shapes.entries()) {
    if (!asked.has(shape.kind)) {
      warnings.push(issue("unused_shape", `shapes[] defines ${shape.kind}, which no function asks for — an exemplar nobody reads`, `shapes[${i}].kind`));
    }
  }

  // ── Swift's test target (ADR-0014) ────────────────────────────────────────────────────────────
  let projectDir: string | null = null;
  try {
    projectDir = findProjectRoot(modulePath, plan.language);
  } catch (e) {
    errors.push(issue("missing_module", String((e as Error).message), "module"));
  }

  if (plan.language === "swift" && projectDir !== null) {
    const targets = testTargets(projectDir);
    const named = opts.testTarget ?? plan.test_target;
    if (named !== undefined && !targets.includes(named)) {
      errors.push(issue("unknown_test_target", `${projectDir} has no test target ${named} — found ${targets.join(", ") || "none"}`, "test_target"));
    } else if (named === undefined && targets.length !== 1) {
      errors.push(issue(
        "ambiguous_test_target",
        targets.length === 0
          ? `${projectDir} has no test target under Tests/, so a candidate has nowhere to go`
          : `${projectDir} has ${targets.length} test targets (${targets.join(", ")}) and the plan names none — verifySwift would refuse after the first candidate (ADR-0014)`,
        "test_target",
      ));
    }
  }

  // ── the exemplars, for real ───────────────────────────────────────────────────────────────────
  let verified = 0;
  if (opts.verifyExemplars === false) {
    warnings.push(issue(
      "exemplars_not_verified",
      "verify_exemplars was false, so no exemplar was compiled, run or mutated — this report says the plan is well formed, not that it works",
      "shapes",
    ));
  } else if (errors.length > 0) {
    // Verifying against a plan that does not load is minutes spent to rediscover what is already in
    // `errors`. Say so rather than reporting `checked.exemplars: 0` with no reason.
    warnings.push(issue(
      "exemplars_not_verified",
      `skipped: ${errors.length === 1 ? "1 error above has" : `${errors.length} errors above have`} to be fixed before an exemplar can be verified against this plan`,
      "shapes",
    ));
  } else {
    const loaded: LoadedPlan = {
      plan,
      planPath: abs,
      modulePath,
      projectDir: projectDir!,
      sourceFile: relative(projectDir!, modulePath).split(sep).join("/"),
      source,
      exemplars: new Map(),
    };

    for (const [i, shape] of plan.shapes.entries()) {
      const path = exemplarPaths.get(shape.kind)!;
      const where = `shapes[${i}].exemplar`;
      const id = taskId(shape.exemplar_function, shape.kind);
      const candidate = Candidate.parse({
        task_id: id,
        // An exemplar has no worker, no seed and no token counts, and `verifyCandidate` reads neither.
        // `sidecrew verify` builds the same fiction for a file a human wrote, for the same reason.
        worker: { kind: "local", model: `exemplar:${shape.kind}`, revision: "", temperature: 0, seed: 0 },
        test_source: await readFile(path, "utf8"),
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        timing: { ttft_ms: 0, wall_ms: 0 },
      });

      try {
        // `rangeFor` takes the range from the module, because an exemplar's function is deliberately
        // not in `functions[]` — that is the fallback's whole purpose (ADR-0015).
        const verdict = await verifyCandidate(loaded, candidate, functionOfTaskId(id), {
          concurrency: opts.concurrency,
          testTarget: opts.testTarget,
        });
        verified += 1;
        say(`${shape.kind}: exemplar ${verdict.survived ? "survived" : `failed at ${verdict.stage_reached}`} (${shape.exemplar})`);
        if (!verdict.survived) {
          errors.push(issue(
            "exemplar_did_not_survive",
            `${shape.exemplar} tests ${shape.exemplar_function} and did not survive: reached ${verdict.stage_reached}, ` +
            `compile ${verdict.compile_ok ? "ok" : "no"}, pass ${verdict.pass_ok ? "ok" : "no"}, ` +
            `tautological ${verdict.tautological ? "yes" : "no"}, killed ${verdict.mutation?.killed ?? 0}` +
            (verdict.error ? `\n${verdict.error}` : ""),
            where,
          ));
        }
      } catch (e) {
        // A verifier that cannot run is a machine problem, and it is not this plan's fault — but the
        // plan is unvalidated either way, so it cannot be called valid.
        errors.push(issue("exemplar_did_not_survive", `${shape.exemplar} could not be verified: ${String((e as Error).message)}`, where));
      }
    }
  }

  return ValidationReport.parse({
    plan: abs,
    valid: errors.length === 0,
    checked: { functions: plan.functions.length, shapes: plan.shapes.length, exemplars: verified },
    errors,
    warnings,
    stale,
  });
}

export const renderReport = (r: ValidationReport): string => {
  const lines = [
    `${r.valid ? "valid  " : "INVALID"} ${r.plan}`,
    `  checked ${r.checked.functions} function${r.checked.functions === 1 ? "" : "s"} · ${r.checked.shapes} shape${r.checked.shapes === 1 ? "" : "s"} · ${r.checked.exemplars} exemplar${r.checked.exemplars === 1 ? "" : "s"} verified`,
  ];
  for (const e of r.errors) lines.push(`  error   [${e.code}] ${e.where ? `${e.where}: ` : ""}${e.message}`);
  for (const w of r.warnings) lines.push(`  warning [${w.code}] ${w.where ? `${w.where}: ` : ""}${w.message}`);
  if (r.stale.length > 0) lines.push(`  stale: ${r.stale.join(", ")} — re-plan before running`);
  return lines.join("\n");
};
