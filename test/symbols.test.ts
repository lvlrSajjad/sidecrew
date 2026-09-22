// Symbol-scoped return — ADR-0075 option C, built as ADR-0086.
//
// Two tests here are the phase's own definition of done rather than coverage: **confinement is decided
// from the task and the candidate alone** (the first describe block's last test), and **a big file stops
// being refused while a big declaration still is** (the validator block).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkConfinement } from "../src/confinement.js";
import { buildChangeTask, fixTokenBudget, parseSymbolEdits, readAnswer, type LoadedChangePlan } from "../src/fix.js";
import { validateChangePlan } from "../src/fix-validate.js";
import { changePromptText } from "../src/prompt.js";
import { ChangeCandidate, ChangeTask, type ConfinementRule } from "../src/schemas.js";
import { declarations, locateSymbols, resolveSymbol, spliceSymbols } from "../src/symbols.js";

const SERVICE = `import { Injectable } from "@nestjs/common";
import { roundTo } from "./money";

/** Rates, by currency code. */
@Injectable()
export class RateService {
  private readonly rates: Record<string, number> = {};

  constructor(private readonly base: string) {}

  /** The rate for a code, or 0. */
  @Cached()
  rateFor(code: string | undefined): number {
    return this.rates[code] ?? 0;
  }

  convert(amount: number, code: string | undefined): number {
    return roundTo(amount * this.rateFor(code), 2);
  }

  get size(): number { return 1; }
  set size(n: number) {}
}

export function parse(x: string): number;
export function parse(x: number): number;
export function parse(x: string | number): number { return Number(x); }

export const LIMIT = 10;
export const A = 1, B = 2;
`;

const PATH = "src/rate.service.ts";

const task = (names: string[], source = SERVICE, path = PATH): ChangeTask => {
  const files = [{ path, source, source_sha: "sha", errors: 1 }];
  const located = locateSymbols(files, names.map((name) => ({ file: path, name })), "");
  if (!Array.isArray(located)) throw new Error(located.problem);
  return ChangeTask.parse({
    task_id: "t", language: "typescript", test_framework: "jest",
    ask: "Fix every TypeScript error in these declarations without changing what the code does.",
    files, diagnostics: "", max_deleted_lines: 0, notes: null, attempt: 0, retry_of: null,
    previous_error: null, correction: null, shape: "null_guard", symbols: located,
  });
};

const candidate = (t: ChangeTask, text: string): ChangeCandidate => {
  const { edits, symbol_edits, unparsed } = readAnswer(text, t);
  return ChangeCandidate.parse({
    task_id: t.task_id, worker: { kind: "local", model: "m", revision: "r", temperature: 0, seed: 42 },
    edits, symbol_edits, unparsed, refusal: null, truncated: false,
    usage: { prompt_tokens: 1, completion_tokens: 1 }, timing: { ttft_ms: 1, wall_ms: 1 },
  });
};

const rules = (t: ChangeTask, c: ChangeCandidate): ConfinementRule[] => checkConfinement(t, c).map((b) => b.rule);

const FIXED = `  @Cached()
  rateFor(code: string | undefined): number {
    return code === undefined ? 0 : this.rates[code] ?? 0;
  }`;

describe("resolveSymbol", () => {
  it("finds a class member, and its span carries its decorator but not its JSDoc", () => {
    const r = resolveSymbol(SERVICE, "RateService.rateFor", PATH);
    if (!r.ok) throw new Error(r.reason);
    const text = SERVICE.slice(r.span.start, r.span.end);
    expect(text.startsWith("@Cached()")).toBe(true);
    expect(text.endsWith("}")).toBe(true);
    expect(text).not.toContain("The rate for a code");
    expect(r.owner).not.toBeNull();
  });

  it("names top-level declarations, the constructor, and a single-name const", () => {
    for (const name of ["RateService", "RateService.constructor", "RateService.rates", "LIMIT"]) {
      expect(resolveSymbol(SERVICE, name, PATH).ok, name).toBe(true);
    }
  });

  it("refuses rather than picks: overloads and get/set pairs are ambiguous", () => {
    expect(resolveSymbol(SERVICE, "parse", PATH)).toMatchObject({ ok: false, reason: "ambiguous", count: 3 });
    expect(resolveSymbol(SERVICE, "RateService.size", PATH)).toMatchObject({ ok: false, reason: "ambiguous", count: 2 });
  });

  it("does not name what it cannot hand back whole", () => {
    // `export const A = 1, B = 2` declares two names in one statement — there is no text that is `A`.
    expect(resolveSymbol(SERVICE, "A", PATH)).toMatchObject({ ok: false, reason: "missing" });
    expect(resolveSymbol(SERVICE, "RateService.nope", PATH)).toMatchObject({ ok: false, reason: "missing" });
    expect(resolveSymbol(SERVICE, "a.b.c", PATH)).toMatchObject({ ok: false, reason: "bad_name" });
  });

  it("keeps duplicates in the enumeration, so the census can count what refusing them costs", () => {
    expect(declarations(SERVICE, PATH)!.filter((d) => d.name === "parse")).toHaveLength(3);
  });
});

describe("the answer, spliced", () => {
  it("replaces the span and leaves every other byte of the file as it was", () => {
    const t = task(["RateService.rateFor"]);
    const c = candidate(t, `--- SYMBOL: ${PATH}#RateService.rateFor ---\n${FIXED}\n`);
    expect(c.edits).toHaveLength(1);
    const after = c.edits[0]!.contents;
    expect(after).toContain("code === undefined ? 0 : this.rates[code] ?? 0");
    const s = t.symbols[0]!;
    expect(after.slice(0, s.start)).toBe(SERVICE.slice(0, s.start));
    expect(after.endsWith(SERVICE.slice(s.end))).toBe(true);
    expect(rules(t, c)).toEqual([]);
  });

  it("accepts a bare answer only when there is exactly one declaration it could be", () => {
    const one = task(["RateService.rateFor"]);
    expect(parseSymbolEdits(FIXED, one).symbol_edits).toHaveLength(1);
    const two = task(["RateService.rateFor", "RateService.convert"]);
    const read = readAnswer(FIXED, two);
    expect(read.edits).toEqual([]);
    expect(read.unparsed).toContain("no `--- SYMBOL: path#name ---` marker");
  });

  it("never reads a symbol task's bare answer as a whole file", () => {
    // `parseEdits`' one-file fallback would otherwise replace a 4,000-line service with one method.
    const t = task(["RateService.rateFor"]);
    const c = candidate(t, FIXED);
    expect(c.edits[0]!.contents.length).toBeGreaterThan(FIXED.length);
    expect(c.edits[0]!.contents).toContain("export function parse(x: string | number)");
  });

  it("keeps a symbol the task does not name, and the gate refuses it by name", () => {
    const t = task(["RateService.rateFor"]);
    const c = candidate(t, `--- SYMBOL: ${PATH}#RateService.rateFor ---\n${FIXED}\n--- SYMBOL: ${PATH}#RateService.convert ---\n  convert() { return 0; }\n`);
    expect(c.symbol_edits.map((e) => e.name)).toEqual(["RateService.rateFor", "RateService.convert"]);
    expect(rules(t, c)).toContain("edit_outside_symbol");
  });

  it("refuses the same declaration returned twice — there is no one answer to splice", () => {
    const t = task(["RateService.rateFor"]);
    const marker = `--- SYMBOL: ${PATH}#RateService.rateFor ---`;
    const c = candidate(t, `${marker}\n${FIXED}\n${marker}\n${FIXED}\n`);
    expect(rules(t, c)).toContain("edit_outside_symbol");
  });

  it("refuses a second declaration smuggled in beside the named one", () => {
    const t = task(["RateService.rateFor"]);
    const c = candidate(t, `--- SYMBOL: ${PATH}#RateService.rateFor ---\n${FIXED}\n\n  helper(): number { return 0; }\n`);
    expect(rules(t, c)).toEqual(["edit_outside_symbol"]);
  });

  it("refuses a rename: the task's name no longer resolves", () => {
    const t = task(["RateService.rateFor"]);
    const c = candidate(t, `--- SYMBOL: ${PATH}#RateService.rateFor ---\n${FIXED.replace("rateFor(", "rateForCode(")}\n`);
    expect(rules(t, c)).toContain("symbol_not_redeclared");
  });

  it("judges a whole-file answer to a symbol task by the same revert", () => {
    const t = task(["RateService.rateFor"]);
    const s = t.symbols[0]!;
    const inside = SERVICE.slice(0, s.start) + FIXED.trimStart() + SERVICE.slice(s.end);
    expect(rules(t, candidate(t, `--- FILE: ${PATH} ---\n${inside}`))).toEqual([]);
    const outside = inside.replace("roundTo(amount", "roundTo(+amount");
    expect(rules(t, candidate(t, `--- FILE: ${PATH} ---\n${outside}`))).toContain("edit_outside_symbol");
  });

  it("is decided from the task and the candidate alone — nothing on disk is read or written", () => {
    // ADR-0086 §4 and the phase's definition of done: confinement is decidable **before** anything is
    // written. The path below does not exist, so a check that reached for the filesystem could not have
    // produced these answers, and nothing may appear there afterwards.
    // Relative, as every task path is: the parser normalises a marker's path the way the contract spells it.
    const ghost = "sidecrew-no-such-dir/src/ghost.service.ts";
    const t = task(["RateService.rateFor"], SERVICE, ghost);
    const good = candidate(t, `--- SYMBOL: ${ghost}#RateService.rateFor ---\n${FIXED}\n`);
    const bad = candidate(t, `--- SYMBOL: ${ghost}#RateService.rateFor ---\n${FIXED}\n\n  helper() {}\n`);
    expect(rules(t, good)).toEqual([]);
    expect(rules(t, bad)).toEqual(["edit_outside_symbol"]);
    expect(existsSync(ghost)).toBe(false);
  });

  it("splices from the task's own source, never from a whole-file answer for the same path", () => {
    const t = task(["RateService.rateFor"]);
    const whole = [{ path: PATH, contents: "whole" }];
    expect(spliceSymbols(t, [{ path: PATH, name: "RateService.rateFor", text: FIXED }], whole)).toEqual(whole);
  });
});

describe("what a symbol task costs and shows", () => {
  it("budgets the declaration, not the file", () => {
    const big = `${SERVICE}\n${"// padding\n".repeat(4000)}`;
    const t = task(["RateService.rateFor"], big);
    expect(fixTokenBudget(t)).toBe(1024);
  });

  it("shows the declaration and what is in scope, never the rest of the file", async () => {
    const text = await changePromptText(task(["RateService.rateFor"]));
    expect(text).toContain(`--- SYMBOL: ${PATH}#RateService.rateFor ---`);
    expect(text).toContain('import { roundTo } from "./money";');
    expect(text).toContain("export class RateService {");
    expect(text).toMatch(/RateService\.rateFor is lines \d+–\d+/);
    expect(text).not.toContain("export function parse(x: string | number)");
    expect(text).not.toContain("--- FILE:");
  });
});

describe("buildChangeTask on a symbol task", () => {
  it("locates the declaration in the sandbox and shows the worker only the compiler's words inside it", () => {
    const FIXTURE = "fixtures/fix-fixture";
    const loaded = { plan: { language: "typescript", test_framework: "vitest" }, projectDir: FIXTURE } as unknown as LoadedChangePlan;
    const inside = "src/rates.ts(11,16): error TS2538: Type 'undefined' cannot be used as an index type.";
    const outside = "src/rates.ts(15,3): error TS9999: somewhere else in the file.";
    const t = buildChangeTask(loaded, {
      task_id: "rates:0", ask: "a", files: ["src/rates.ts"], max_deleted_lines: 0, blocking: false,
      shape: "null_guard", symbols: [{ file: "src/rates.ts", name: "rateFor" }],
    }, FIXTURE, { baseline: { errors: { total: 2, by_file: { "src/rates.ts": 2 } } }, diagnostics: `${inside}\n${outside}` } as never);
    expect(t.symbols).toHaveLength(1);
    expect(t.symbols[0]).toMatchObject({ name: "rateFor", start_line: 10, end_line: 12, errors: 1 });
    expect(t.symbols[0]!.source.startsWith("export function rateFor(")).toBe(true);
    expect(t.diagnostics).toBe(inside);
  });
});

describe("validateChangePlan on a symbol task", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidecrew-symbols-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // One file far over the whole-file ceiling (~22,674 chars), holding one small method and one huge one.
  const huge = `  huge(): number {\n${"    const x = 1 + 1; // a line that costs tokens to return\n".repeat(900)}    return 0;\n  }`;
  const big = `export class Big {\n  small(n: number): number {\n    return n + 1;\n  }\n\n${huge}\n}\n`;
  writeFileSync(join(dir, "package.json"), "{}\n");
  writeFileSync(join(dir, "big.ts"), big);

  const plan = (tasks: unknown[]): string => {
    const path = join(dir, `plan-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify({
      version: 1, language: "typescript", project: dir, test_framework: "jest",
      meta: { planner_model: "hand", planner_tokens: 0, created: "2026-09-22T00:00:00Z" },
      steps: [{ name: "s", tasks }],
    }));
    return path;
  };
  const codes = async (tasks: unknown[]): Promise<string[]> =>
    (await validateChangePlan(plan(tasks), { compile: false })).errors.map((e) => e.code);
  const base = { ask: "a", files: ["big.ts"], shape: "null_guard" };

  it("the file is refused whole — this is the clause 14c exists to stop firing", async () => {
    expect(big.length).toBeGreaterThan(22_674);
    expect(await codes([{ ...base, task_id: "whole" }])).toContain("files_too_large_to_rewrite");
  });

  it("a small declaration in the same file is in reach", async () => {
    expect(await codes([{ ...base, task_id: "small", symbols: [{ file: "big.ts", name: "Big.small" }] }])).toEqual([]);
  });

  it("a big declaration is still refused — the change is big, not the file (ADR-0075)", async () => {
    expect(await codes([{ ...base, task_id: "huge", symbols: [{ file: "big.ts", name: "Big.huge" }] }]))
      .toEqual(["symbols_too_large_to_rewrite"]);
  });

  it("refuses by name what it cannot locate, and what overlaps", async () => {
    expect(await codes([{ ...base, task_id: "m", symbols: [{ file: "big.ts", name: "Big.nope" }] }])).toEqual(["symbol_missing"]);
    expect(await codes([{ ...base, task_id: "o", symbols: [{ file: "big.ts", name: "Big" }, { file: "big.ts", name: "Big.small" }] }]))
      .toContain("symbols_overlap");
  });
});
