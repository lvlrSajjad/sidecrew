// The worker prompt: `src/prompts/worker.md` (+ `retry.md` on the second attempt) plus a `WorkerTask`.
//
// The template is a file rather than a string literal because Phase 5 tunes its wording and measures
// the ablation (bare / +exemplar / +exemplar+rules); a prompt that lives in source gets edited by
// whoever is in the file, and a prompt that lives in a file gets edited on purpose.
//
// The templating is deliberately the smallest thing that renders that file: `{{var}}` and
// `{{#var}}…{{/var}}`. It is not a dependency and it is not Mustache — no partials, no loops, no
// escaping. Escaping in particular would be wrong here: the value being substituted is source code
// going to a language model, and the only correct transformation of it is none.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Message } from "./worker.js";
import type { ChangeTask, WorkerTask } from "./schemas.js";
import { indentAt } from "./symbols.js";

const TEMPLATE_PATH = fileURLToPath(new URL("./prompts/worker.md", import.meta.url));
const RETRY_TEMPLATE_PATH = fileURLToPath(new URL("./prompts/retry.md", import.meta.url));

export const workerTemplate = async (): Promise<string> => readFile(TEMPLATE_PATH, "utf8");

/**
 * The retry prompt, which is the first-attempt prompt plus this (ADR-0022).
 *
 * A separate file rather than a `{{#previous_error}}` block inside `worker.md`, and the split is not
 * cosmetic: `test/prompt.test.ts` pins `worker.md`'s rendered bytes to the ablation variants that
 * measured them (ADR-0017, ADR-0021), so every edit to the retry wording used to land inside a file
 * nothing may edit without rerunning an ablation. Two files mean the retry can be reworded — and
 * measured — on its own.
 *
 * It renders to the empty string for a task with no `previous_error`, so a first attempt composes to
 * exactly what `worker.md` alone produced before the split. That is a test, not a claim.
 */
export const retryTemplate = async (): Promise<string> => readFile(RETRY_TEMPLATE_PATH, "utf8");

/** A missing value and an empty one are the same thing to a section: there is nothing to say. */
export type Vars = Record<string, string | null | undefined>;

const SECTION = /\{\{#(\w+)\}\}\n?([\s\S]*?)\{\{\/\1\}\}\n?/g;
const VARIABLE = /\{\{(\w+)\}\}/g;

/**
 * Render `template` with `vars`, in one pass.
 *
 * One pass matters: a substituted value is source code, and source code containing `{{` must not be
 * read as a placeholder. So the variable pass walks the template and copies values in; it never
 * re-scans what it wrote.
 *
 * An unknown placeholder throws. The alternative — leaving `{{shape_rules}}` in the text — ships a
 * literal brace sequence to a 7B model and shows up as an unexplained dip in survival rate three
 * phases later, which is the most expensive kind of quiet failure this project can have.
 */
export function render(template: string, vars: Vars): string {
  const known = (name: string): string => {
    if (!(name in vars)) throw new Error(`prompt template uses {{${name}}}, which nothing supplies`);
    return vars[name] ?? "";
  };

  // Sections first, so a variable inside a section that is dropped is never asked for.
  const sectioned = template.replace(SECTION, (_, name: string, body: string) =>
    known(name).trim() === "" ? "" : body);

  return sectioned.replace(VARIABLE, (_, name: string) => known(name));
}

/**
 * The fixed cost of the prompt — everything except the two variable-length values.
 *
 * Under 600 tokens is a design constraint, not a measurement: the worker's context is shared with a
 * function's source and an entire exemplar file, and the exemplar is what the research says does the
 * work (§B). Instructions that crowd it out are instructions that cost survival rate.
 */
export const PROMPT_BUDGET_TOKENS = 600;

/**
 * Tokens, roughly, at ~4 characters each.
 *
 * An estimate and labelled as one — the real count comes back in `Candidate.usage.prompt_tokens` from
 * the worker itself, which is what any number in the docs is taken from. This exists so the budget
 * above can be a test rather than an intention.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * The type a function is reached through — `Numbers` for `Numbers.percentChange(from:to:)` — or "".
 *
 * The prompt renders the *signature* and uses this only as the condition, through an inline
 * `{{#function_qualified}}` section, so the rendered bytes are exactly one of the two arms Phase 6's
 * follow-up ablation measured: `experiments/signature-ablation/variants/signature.md` when there is an
 * owner, and `shipped.md` when there is not. A better-sounding wording would have been an unmeasured
 * wording, which is the mistake ADR-0017 exists to prevent.
 *
 * Why this is conditional rather than "always render the signature". A `line_range` slices a function
 * out of its enclosing type, so the worker sees `public static func percentChange(...)` and has to
 * infer that it is reached as `Numbers.…`. Phase 6 measured what happens when it infers wrong: the 7B
 * reached for the module name in `imports_hint`, wrote `SwiftFixture.percentChange(...)`, and 13 of 18
 * Swift candidates never compiled. Rendering the owner nearly doubled Swift compiles, 6 → 12 of 18
 * first attempts, and survival 4 → 7 (ADR-0021).
 *
 * On a top-level function the same line says nothing `function_source` and `imports_hint` did not
 * already say, and the measurement is that redundancy is not free: the TypeScript fixture, whose
 * signatures are unqualified, went 17 → 16 with the line always rendered. So the rule is the mechanism
 * rather than the language — say where the function lives exactly when that is not already obvious.
 * A TypeScript class method signature, `Cart.total(...)`, gets the line for the same reason Swift does.
 *
 * `signature` is the planner's, and the spec's example is unqualified (`slugify(input: string): string`),
 * so "no owner" is the ordinary case and not a failure.
 */
export function owningType(fn: { name: string; signature: string }): string {
  const beforeParen = fn.signature.split("(")[0] ?? "";
  const dot = beforeParen.lastIndexOf(".");
  if (dot <= 0) return "";
  const owner = beforeParen.slice(0, dot).trim();
  const named = beforeParen.slice(dot + 1).trim();
  // Only when the tail really is this function: a signature we cannot parse must not invent an owner.
  return named === fn.name && /^[\w.$]+$/.test(owner) ? owner : "";
}

export const vars = (task: WorkerTask): Vars => ({
  language: task.language,
  test_framework: task.test_framework,
  function_source: task.function.source,
  /** The full signature when the function lives inside a type, and empty when it does not. */
  function_qualified: owningType(task.function) === "" ? "" : task.function.signature,
  imports_hint: task.imports_hint,
  shape_kind: task.shape.kind,
  shape_rules: task.shape.rules,
  exemplar_source: task.exemplar_source,
  previous_error: task.previous_error,
});

/** Overrides for the two templates. Nothing in the pipeline passes either; the ablations do. */
export interface PromptOpts {
  template?: string;
  retry?: string;
}

/**
 * The text of one prompt: the worker template, plus the retry template when there is an error to carry.
 *
 * Concatenation rather than a second pass over one file, so the retry prompt *contains* the first
 * attempt's prompt verbatim. The worker is being asked to fix a specific file it wrote, and moving the
 * instructions around between attempts would vary two things at once — which is the mistake ADR-0017
 * exists to prevent.
 */
export async function promptText(task: WorkerTask, opts: PromptOpts = {}): Promise<string> {
  const v = vars(task);
  return render(opts.template ?? await workerTemplate(), v) + render(opts.retry ?? await retryTemplate(), v);
}

/**
 * One user message. No system prompt: mlx_lm applies the model's own chat template, and Qwen2.5-Coder
 * follows an instruction in the user turn perfectly well — a second role would be one more thing for
 * Phase 5's ablation to hold constant for no measured gain.
 */
export async function buildPrompt(task: WorkerTask, opts: PromptOpts = {}): Promise<Message[]> {
  return [{ role: "user", content: await promptText(task, opts) }];
}

// ── workload #2a: the fixer prompt (Phase 10) ─────────────────────────────────────────────────────

const FIXER_TEMPLATE_PATH = fileURLToPath(new URL("./prompts/fixer.md", import.meta.url));
const FIX_RETRY_TEMPLATE_PATH = fileURLToPath(new URL("./prompts/fix-retry.md", import.meta.url));
const SYMBOL_TEMPLATE_PATH = fileURLToPath(new URL("./prompts/fixer-symbol.md", import.meta.url));
const SYMBOL_RETRY_TEMPLATE_PATH = fileURLToPath(new URL("./prompts/fix-symbol-retry.md", import.meta.url));

/**
 * ADR-0086 §5: a symbol-scoped task has its own template rather than a section inside `fixer.md`, so the
 * whole-file prompt stays byte-identical and so does every candidate-cache key and measured number that
 * depends on it. The retry is split for the reason `fix-retry.md` is: it asks for the answer's form.
 */
export const symbolFixerTemplate = async (): Promise<string> => readFile(SYMBOL_TEMPLATE_PATH, "utf8");
export const symbolRetryTemplate = async (): Promise<string> => readFile(SYMBOL_RETRY_TEMPLATE_PATH, "utf8");

export const fixerTemplate = async (): Promise<string> => readFile(FIXER_TEMPLATE_PATH, "utf8");

/**
 * The retry half, split from `fixer.md` for the same reason `retry.md` is split from `worker.md`: the
 * first-attempt wording is what an ablation measures, and a retry reworded inside it would move two
 * things at once (ADR-0017).
 *
 * It renders `{{correction}}` as well as `{{previous_error}}`, and nothing fills `correction` until
 * Phase 12 builds the correction round (ADR-0044 §4). A contract field the prompt never renders is the
 * mistake `PlannedFunction.notes` is still making — it is in the plan, the planner writes rules into
 * it, and the worker has never seen one. One section now costs nothing and closes that hole in advance.
 */
export const fixRetryTemplate = async (): Promise<string> => readFile(FIX_RETRY_TEMPLATE_PATH, "utf8");

/**
 * The files, rendered into the one block the template inlines.
 *
 * A marker line per file, in the same `--- FILE: path ---` form the worker is asked to answer in, so
 * the question and the answer have the same shape. A 7B copying the form it was shown is the cheapest
 * instruction-following there is, and Phase 6 measured what the alternative costs: a model that guesses
 * at a form gets it wrong in a way that reads as an inability to write code (ADR-0019, ADR-0021).
 */
export const filesBlock = (files: { path: string; source: string }[]): string =>
  files.map((f) => `--- FILE: ${f.path} ---\n${f.source}`).join("\n\n");

/**
 * What a symbol task's worker may read and not change: per file, its imports, and for each class a member
 * belongs to, the class's header — with the line each declaration sits on, because the diagnostics
 * speak in the file's line numbers and the worker is not shown the file.
 */
export const contextBlock = (task: ChangeTask): string => {
  const out: string[] = [];
  for (const file of task.files) {
    const mine = task.symbols.filter((s) => s.path === file.path);
    if (mine.length === 0) continue;
    const parts = [`--- CONTEXT: ${file.path} ---`];
    if (mine[0]!.imports !== "") parts.push(mine[0]!.imports, "");
    for (const enclosing of [...new Set(mine.map((s) => s.enclosing).filter((e) => e !== ""))]) parts.push(`${enclosing}\n  …\n}`, "");
    for (const s of mine) parts.push(`${s.name} is lines ${s.start_line}–${s.end_line} of ${file.path}.`);
    out.push(parts.join("\n"));
  }
  return out.join("\n\n");
};

/** Each declaration in the `--- SYMBOL:` form the worker answers in, indented as it is in its file. */
export const symbolsBlock = (task: ChangeTask): string =>
  task.symbols.map((s) => {
    const file = task.files.find((f) => f.path === s.path)!.source;
    return `--- SYMBOL: ${s.path}#${s.name} ---\n${indentAt(file, s.start)}${s.source}`;
  }).join("\n\n");

export const changeVars = (task: ChangeTask): Vars => ({
  language: task.language,
  test_framework: task.test_framework,
  ask: task.ask,
  notes: task.notes,
  diagnostics: task.diagnostics,
  files_block: task.symbols.length === 0 ? filesBlock(task.files) : "",
  context_block: task.symbols.length === 0 ? "" : contextBlock(task),
  symbols_block: task.symbols.length === 0 ? "" : symbolsBlock(task),
  previous_error: task.previous_error,
  correction: task.correction,
});

export async function changePromptText(task: ChangeTask, opts: PromptOpts = {}): Promise<string> {
  const v = changeVars(task);
  if (task.symbols.length > 0) {
    return render(opts.template ?? await symbolFixerTemplate(), v) + render(opts.retry ?? await symbolRetryTemplate(), v);
  }
  return render(opts.template ?? await fixerTemplate(), v) + render(opts.retry ?? await fixRetryTemplate(), v);
}

export async function buildChangePrompt(task: ChangeTask, opts: PromptOpts = {}): Promise<Message[]> {
  return [{ role: "user", content: await changePromptText(task, opts) }];
}
