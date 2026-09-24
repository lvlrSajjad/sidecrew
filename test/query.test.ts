// `sidecrew query` on the fix fixture and on a scratch project, with the compiler in-process (ADR-0090
// §4 piece 3). `diagnostics` shells out to `tsc` and is in query.slow.test.ts.
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_FIX_TOKENS } from "../src/fix.js";
import { isUnder, parseDiagnostics, query, renderQuery } from "../src/query.js";
import { QueryAnswer } from "../src/schemas.js";

const FIXTURE = "fixtures/fix-fixture";

describe("query refs — the compiler's references, not a grep's", () => {
  it("counts every use of roundTo, and says how many are in tests", async () => {
    const a = await query("refs", FIXTURE, { symbols: ["src/money.ts:roundTo"] });
    if (a.kind !== "refs") throw new Error("wrong kind");
    const r = a.items[0]!;
    expect(r.found).toBe(true);
    // cart.ts, rates.ts and money.ts itself use it, and so do two test files.
    expect(r.files).toBeGreaterThanOrEqual(5);
    expect(r.from_tests).toBeGreaterThan(0);
    expect(r.references).toBeGreaterThan(r.from_tests);
    expect(r.locations.map((l) => l.file)).toContain("src/cart.ts");
  });

  it("says NOT FOUND for a name the file does not declare, with no counts", async () => {
    const a = await query("refs", FIXTURE, { symbols: ["src/money.ts:nope", "src/elsewhere.ts:roundTo"] });
    if (a.kind !== "refs") throw new Error("wrong kind");
    expect(a.items.map((i) => i.found)).toEqual([false, false]);
    expect(renderQuery(a)).toContain("NOT FOUND");
  });

  it("refuses a symbol spec without a file", async () => {
    await expect(query("refs", FIXTURE, { symbols: ["roundTo"] })).rejects.toThrow(/file:Name/);
  });
});

describe("query unreferenced — exports nothing outside their file uses", () => {
  it("finds the six the fixture has, and marks the ones only tests use", async () => {
    const a = await query("unreferenced", FIXTURE);
    if (a.kind !== "unreferenced") throw new Error("wrong kind");
    expect(a.scanned).toBe(9);
    expect(a.items.map((i) => i.name).sort()).toEqual(["Cart", "convert", "discounted", "lineTotal", "rateFor", "renderTotal"]);
    expect(a.items.find((i) => i.name === "convert")!.refs_from_tests).toBeGreaterThan(0);
    expect(a.items.find((i) => i.name === "Cart")!.refs_from_tests).toBe(0);
  });

  it("caps the list and says so, keeping the total", async () => {
    const a = await query("unreferenced", FIXTURE, { limit: 2 });
    expect(a.items).toHaveLength(2);
    expect(a.total).toBe(6);
    expect(a.truncated).toBe(true);
    expect(renderQuery(a)).toMatch(/showing 2 of 6/);
  });

  it("scans only under a prefix when asked", async () => {
    const a = await query("unreferenced", FIXTURE, { under: "src/rates.ts" });
    if (a.kind !== "unreferenced") throw new Error("wrong kind");
    expect(a.scanned).toBe(2);
    expect(a.items.map((i) => i.name).sort()).toEqual(["convert", "rateFor"]);
  });
});

describe("query on a project with a decorated class and a file too big to rewrite", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "sidecrew-query-"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "package.json"), '{"name":"q","private":true}');
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", experimentalDecorators: true, noEmit: true, skipLibCheck: true },
      include: ["src"],
    }));
    await writeFile(join(dir, "src/entity.ts"), "const Entity = (): ClassDecorator => () => {};\n@Entity()\nexport class Order { id = 1; }\n");
    // Many small declarations whose sum is far past the ceiling: the file cannot be rewritten whole, and
    // every one of its declarations can be a symbol task on its own.
    const body = Array.from({ length: 400 }, (_, i) => `export function f${i}(x: number): number {\n  return x + ${i}; // ${"pad ".repeat(10)}\n}\n`).join("");
    await writeFile(join(dir, "src/big.ts"), body);
    await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("marks a decorated class, because a reference count cannot see reflection", async () => {
    const a = await query("unreferenced", dir, { under: "src/entity.ts" });
    if (a.kind !== "unreferenced") throw new Error("wrong kind");
    expect(a.items).toEqual([expect.objectContaining({ name: "Order", kind: "class", decorated: true })]);
    expect(renderQuery(a)).toContain("DECORATED");
  });

  it("says which files do not fit, and how many of their declarations do", async () => {
    const a = await query("sizes", dir);
    if (a.kind !== "sizes") throw new Error("wrong kind");
    expect(a.ceiling).toBe(MAX_FIX_TOKENS);
    const big = a.items[0]!;
    expect(big.file).toBe("src/big.ts");
    expect(big.fits).toBe(false);
    expect(big.declarations).toBe(400);
    expect(big.declarations_fitting).toBe(400);
    expect(a.fitting).toBe(1);
    expect(renderQuery(a)).toMatch(/TOO BIG — 400\/400/);
  });
});

describe("the QueryAnswer contract", () => {
  const base = { version: 1, project: "p", tsconfig: "tsconfig.json", created: "2026-09-24T10:00:00.000Z", ms: 1 };

  it("does not let a capped list pass as complete, or a complete one claim a cap", () => {
    const item = { file: "a.ts", line: 1, code: "TS6133", message: "x" };
    const d = { ...base, kind: "diagnostics", under: null, flag: "--noUnusedLocals", added_only: true, codes: [] };
    expect(QueryAnswer.safeParse({ ...d, total: 2, truncated: true, items: [item] }).success).toBe(true);
    expect(QueryAnswer.safeParse({ ...d, total: 2, truncated: false, items: [item] }).success).toBe(false);
    expect(QueryAnswer.safeParse({ ...d, total: 1, truncated: true, items: [item] }).success).toBe(false);
  });

  it("does not let a size claim to fit over the ceiling", () => {
    const s = { ...base, kind: "sizes", under: null, ceiling: 100, fitting: 1, total: 1, truncated: false };
    const item = { file: "a.ts", chars: 1000, rewrite_tokens: 500, declarations: null, declarations_fitting: null };
    expect(QueryAnswer.safeParse({ ...s, items: [{ ...item, fits: true }] }).success).toBe(false);
  });

  it("does not let a symbol that was not found carry references", () => {
    const r = { ...base, kind: "refs", total: 1, truncated: false };
    const item = { file: "a.ts", name: "x", found: false, references: 3, files: 1, from_tests: 0, locations: [], locations_truncated: true };
    expect(QueryAnswer.safeParse({ ...r, items: [item] }).success).toBe(false);
  });
});

describe("helpers", () => {
  it("isUnder matches a directory prefix, not a string prefix", () => {
    expect(isUnder("src/common/a.ts", "src/common")).toBe(true);
    expect(isUnder("src/common/a.ts", "./src/common/")).toBe(true);
    expect(isUnder("src/commonx/a.ts", "src/common")).toBe(false);
    expect(isUnder("anything.ts", undefined)).toBe(true);
  });

  it("parseDiagnostics makes sandbox paths project-relative and keeps the code", () => {
    const d = parseDiagnostics("/tmp/sb/src/a.ts(3,7): error TS6133: 'x' is declared but its value is never read.\nnoise", "/tmp/sb");
    expect(d).toEqual([{ file: "src/a.ts", line: 3, col: 7, code: "TS6133", message: "'x' is declared but its value is never read." }]);
  });
});
