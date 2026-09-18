// Phase 11b arm D — the gate applied to a model's own output, with no sidecrew worker involved.
//
//   npx tsx scripts/arm-d-11b.ts <plan.json> <arm-sandbox-dir> <label>
//
// **This is the arm that tests the thesis rather than the product.** Arms A and C differ in two
// things at once — which model wrote the change, and whether a gate judged it — so neither can tell
// you which one did the work. Arm D holds the model fixed at Opus and varies only the gate: it takes
// the diffs arm A already produced and puts them through exactly the pipeline arm C's candidates go
// through. If D's precision beats A's, the gate is doing something independently of who wrote the
// code, which is the claim `VISION.md` actually makes.
//
// It reuses `runFix` for the same reason the go/no-go harness does: the steps, the baseline capture,
// the confinement check, the gate and the step boundary are the production ones rather than a copy
// of them in a script. Only the generator is swapped — instead of asking a worker, it reads what the
// arm already wrote.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runFix } from "../src/fix.js";
import { ChangeCandidate, type ChangeTask } from "../src/schemas.js";

const [planPath, sandbox, label] = process.argv.slice(2);
if (planPath === undefined || sandbox === undefined || label === undefined) {
  process.stderr.write("usage: arm-d-11b.ts <plan.json> <arm-sandbox-dir> <label>\n");
  process.exit(1);
}

/**
 * The candidate is whatever the arm left on disk, read back as whole files.
 *
 * `ChangeCandidate.edits` is `[{path, contents}]` (ADR-0047 §2), which is exactly the shape a
 * directory of edited files already is — so no diff has to be parsed and nothing can fail to apply.
 * A file the arm did not touch is still included: confinement is judged on a comparison of contents,
 * so an unchanged file contributes nothing and omitting it would understate what the arm delivered.
 */
const fromSandbox = async (task: ChangeTask): Promise<ChangeCandidate> => {
  const edits = await Promise.all(task.files.map(async (f) => ({
    path: f.path,
    contents: await readFile(join(sandbox, f.path), "utf8"),
  })));
  return ChangeCandidate.parse({
    task_id: task.task_id,
    // `api`: the change was written by a model reached over the network, which is what this tier
    // means. No seed exists there, and the tokens were counted by the harness that produced the
    // diffs rather than by this run — `workerTokens` is passed in by the caller, not invented here.
    worker: { kind: "api", model: label, revision: "", temperature: 0, seed: null },
    edits,
    unparsed: null,
    // ADR-0062 option B made `refusal` a required nullable field on `ChangeCandidate`, after this
    // script was written. An arm that replays diffs off disk can never refuse — there is no worker in
    // the loop to decline — so it is always null here, and that is a statement about this arm rather
    // than a placeholder. Omitting it made every task throw at `generate` with a zod error naming
    // `refusal`, which reads like a worker refusal in the log and is nothing of the kind.
    refusal: null,
    truncated: false,
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    timing: { ttft_ms: 0, wall_ms: 0 },
  });
};

const result = await runFix(planPath, {
  generate: fromSandbox,
  workerKind: "api",
  workerModel: label,
  // The generation cost belongs to the arm that produced the diffs and is reported there; counting
  // it again here would double it.
  workerTokens: 0,
  onEvent: (l) => process.stdout.write(`  ${l}\n`),
});

process.stdout.write(
  `\nARM-D ${label}: ${result.stats.survived}/${result.stats.tasks} survived · ` +
  `${result.project.errors_before} → ${result.project.errors_after} tsc errors\n`,
);
