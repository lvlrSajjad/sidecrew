// The templating, and the one budget the worker prompt has to stay inside.
import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import {
  buildPrompt, estimateTokens, owningType, promptText, PROMPT_BUDGET_TOKENS, render, retryTemplate, vars, workerTemplate,
} from "../src/prompt.js";
import { buildTasks, loadPlan } from "../src/plan.js";
import { WorkerTask } from "../src/schemas.js";

const task = WorkerTask.parse({
  task_id: "slugify:boundary:0",
  language: "typescript",
  test_framework: "vitest",
  function: {
    name: "slugify",
    signature: "slugify(input: string): string",
    source: "export function slugify(input: string): string { return input; }",
    source_sha: "9f2c",
  },
  imports_hint: 'import { slugify } from "../src/strings";',
  shape: { kind: "boundary", rules: "Empty input, one element." },
  exemplar_source: 'import { describe } from "vitest";',
  retry_of: null,
  previous_error: null,
});

describe("render", () => {
  it("substitutes what it is given", () => {
    expect(render("a {{x}} c", { x: "b" })).toBe("a b c");
  });

  it("does not re-scan a substituted value", () => {
    // The value is source code. `{{` inside it is two braces, not a placeholder, and a second pass
    // would either throw or interpolate something the model wrote.
    expect(render("{{code}}", { code: "const t = `{{x}}`;", x: "never" })).toBe("const t = `{{x}}`;");
  });

  it("keeps a section whose variable has something in it, and drops one that does not", () => {
    const t = "head\n{{#err}}saw: {{err}}\n{{/err}}tail";
    expect(render(t, { err: "boom" })).toBe("head\nsaw: boom\ntail");
    expect(render(t, { err: null })).toBe("head\ntail");
    expect(render(t, { err: "   " })).toBe("head\ntail");
  });

  it("throws on a placeholder nothing supplies, rather than sending braces to a model", () => {
    expect(() => render("{{nope}}", {})).toThrow(/\{\{nope\}\}/);
  });

  it("does not ask for a variable that only appears inside a dropped section", () => {
    expect(render("{{#err}}{{detail}}{{/err}}ok", { err: null })).toBe("ok");
  });
});

describe("the worker prompt", () => {
  it("renders every variable the template asks for", async () => {
    const [message] = await buildPrompt(task);
    expect(message?.role).toBe("user");
    expect(message?.content).not.toMatch(/\{\{/);
    expect(message?.content).toContain("slugify(input: string): string".slice(0, 7));
    expect(message?.content).toContain('import { slugify } from "../src/strings";');
    expect(message?.content).toContain("Empty input, one element.");
  });

  it("says nothing about a previous attempt on the first try, and does on the retry", async () => {
    const [first] = await buildPrompt(task);
    expect(first?.content).not.toMatch(/previous attempt/i);

    const [retry] = await buildPrompt({ ...task, retry_of: task.task_id, previous_error: "tsc: expected ';'" });
    expect(retry?.content).toMatch(/previous attempt/i);
    expect(retry?.content).toContain("tsc: expected ';'");
  });
});

describe("the retry prompt — ADR-0022", () => {
  const retried = { ...task, retry_of: task.task_id, previous_error: "tsc: expected ';'" };

  it("is the first attempt's prompt, plus something", async () => {
    // Concatenation rather than a second pass over one file: the worker is being asked to fix a file it
    // wrote, and moving the instructions around between attempts would vary two things at once. It also
    // means the retry inherits every measured byte of `worker.md` rather than a second copy of it.
    const first = await promptText(task);
    const retry = await promptText(retried);
    expect(retry.startsWith(first)).toBe(true);
    expect(retry.slice(first.length)).toBe(
      "Your previous attempt failed:\ntsc: expected ';'\nFix that and output the corrected file.\n",
    );
  });

  it("adds nothing at all when there is no error to carry", async () => {
    // Which is what makes a first attempt byte-identical to what one template produced before the split,
    // and therefore what keeps the ablation's numbers attached to the prompt that ships.
    expect(render(await retryTemplate(), vars(task))).toBe("");
    expect(await promptText(task)).toBe(render(await workerTemplate(), vars(task)));
  });

  it("composes to exactly what the one template produced before the split", async () => {
    // The strongest available statement that ADR-0022 changed no bytes: the ablation variant files
    // predate the split and still carry the `{{#previous_error}}` section, so rendering one of them with
    // an error is what the shipped prompt used to be. A retry prompt that drifted from it would mean the
    // split had quietly reworded the thing it exists to leave alone.
    const shipped = await readFile("experiments/signature-ablation/variants/shipped.md", "utf8");
    const withSignature = { ...vars(retried), function_signature: retried.function.signature };
    expect(await promptText(retried)).toBe(render(shipped, withSignature));
  });

  it("is a file of its own, so its wording can be measured without touching the measured one", async () => {
    // `worker.md` is pinned byte-for-byte to the ablation variants (ADR-0017, ADR-0021). Before the
    // split, every edit to the retry wording landed inside that file.
    const worker = await workerTemplate();
    expect(worker).not.toContain("previous_error");
    expect(await retryTemplate()).toContain("{{previous_error}}");
  });

  it("is the variant the ablation kept, for a function that owns itself", async () => {
    // "Keep the winner" is a claim about a file, so it is a test about a file. `exemplar+rules` won at
    // 17/20 against 16 for one sentence about the import and 15 for the exemplar alone
    // (experiments/go-no-go/results/prompt-ablation-2026-09-14.json, ADR-0017). Editing the shipped
    // prompt without rerunning the ablation fails here, which is the point: the wording is measured.
    //
    // ADR-0021 added one conditional clause, so this can no longer be equality between two files — a
    // top-level function renders no clause, and *that* rendering is what has to stay byte-identical to
    // the winner. The qualified rendering is pinned to its own measured variant in the ADR-0021 block
    // below. Between the two, every byte the worker can receive is still pinned to a measurement.
    const winner = await readFile("experiments/prompt-ablation/variants/exemplar-rules.md", "utf8");
    const topLevel = buildTasks(await loadPlan("fixtures/ts-fixture/plans/numbers/test_plan.json"))[0]!;
    expect(owningType(topLevel.function)).toBe("");
    expect(render(await workerTemplate(), vars(topLevel))).toBe(render(winner, vars(topLevel)));
  });

  it("costs under the budget with the source and the exemplar taken out", async () => {
    // The exemplar is what the research says does the work (§B). Instructions that crowd it out of the
    // context are instructions that cost survival rate, so the fixed cost is a test and not a hope.
    const fixed = render(await workerTemplate(), { ...vars(task), function_source: "", exemplar_source: "", previous_error: null });
    expect(estimateTokens(fixed)).toBeLessThan(PROMPT_BUDGET_TOKENS);
  });
});

describe("function_qualified — ADR-0021", () => {
  const fn = (name: string, signature: string) => ({ name, signature });

  it("finds the owner only when the signature really is qualified with this function's name", () => {
    expect(owningType(fn("percentChange", "Numbers.percentChange(from: Double, to: Double) throws -> Double"))).toBe("Numbers");
    expect(owningType(fn("total", "Cart.total(items: Item[]): number"))).toBe("Cart");
    // The spec's own example, and the ordinary case: a top-level function owns nothing.
    expect(owningType(fn("slugify", "slugify(input: string): string"))).toBe("");
    // A dot that is not an owner must not become one.
    expect(owningType(fn("roundTo", "roundTo(value: number, decimals: number): number"))).toBe("");
    expect(owningType(fn("slugify", "Other.notSlugify(input: string): string"))).toBe("");
    expect(owningType(fn("slugify", ".slugify(x)"))).toBe("");
  });

  it("renders exactly the two prompts the ablation measured, byte for byte", async () => {
    // The whole point of making this conditional rather than unconditional: Swift's 7/18 and
    // TypeScript's 17/20 are first-attempt numbers taken on two specific prompt files. They only carry
    // over to the shipped template if the shipped template produces the same bytes, so that is a test
    // rather than a claim.
    const template = await workerTemplate();
    const swift = buildTasks(await loadPlan("fixtures/swift-fixture/plans/Numbers/test_plan.json"))[0]!;
    const ts = buildTasks(await loadPlan("fixtures/ts-fixture/plans/numbers/test_plan.json"))[0]!;

    const measured = async (variant: string): Promise<string> =>
      readFile(`experiments/signature-ablation/variants/${variant}.md`, "utf8");

    // The variant files use {{function_signature}}; the shipped one gates {{function_qualified}}.
    const asVariant = (task: typeof swift): Record<string, string | null | undefined> =>
      ({ ...vars(task), function_signature: task.function.signature });

    expect(render(template, vars(swift))).toBe(render(await measured("signature"), asVariant(swift)));
    expect(render(template, vars(ts))).toBe(render(await measured("shipped"), asVariant(ts)));
  });

  it("keeps the fixed prompt under budget with the line rendered", async () => {
    const swift = buildTasks(await loadPlan("fixtures/swift-fixture/plans/Numbers/test_plan.json"))[0]!;
    const fixed = render(await workerTemplate(), { ...vars(swift), function_source: "", exemplar_source: "" });
    expect(estimateTokens(fixed)).toBeLessThan(PROMPT_BUDGET_TOKENS);
  });
});
