import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BatchResult, Candidate, StatusReport, TestPlan, Verdict, ValidationReport, WorkerTask, survives,
} from "../src/schemas.js";

const SPEC = fileURLToPath(new URL("../docs/specs/pipeline.md", import.meta.url));

/**
 * The spec examples are illustrative JSON: they carry `// …` notes on the fields that need them.
 * Strip those, but only outside string literals — `"http://localhost:8000/v1"` must survive.
 */
const stripLineComments = (src: string): string => {
  let out = "";
  let inString = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i += 1; } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i += 1; out += "\n"; continue; }
    out += c;
  }
  return out;
};

/** Every ```json block in the spec, keyed by the first word of the `## ` heading above it. */
const specExamples = (): Map<string, unknown> => {
  const lines = readFileSync(SPEC, "utf8").split("\n");
  const found = new Map<string, unknown>();
  let heading = "";
  for (let i = 0; i < lines.length; i += 1) {
    const h = /^##\s+`?(\w+)/.exec(lines[i]!);
    if (h) { heading = h[1]!; continue; }
    if (lines[i] !== "```json") continue;
    const end = lines.indexOf("```", i + 1);
    expect(end, `unterminated json block under ## ${heading}`).toBeGreaterThan(i);
    const body = lines.slice(i + 1, end).join("\n");
    expect(found.has(heading), `two json blocks under ## ${heading}`).toBe(false);
    found.set(heading, JSON.parse(stripLineComments(body)));
    i = end;
  }
  return found;
};

const SCHEMAS: Record<string, z.ZodTypeAny> = {
  TestPlan, WorkerTask, Candidate, Verdict, BatchResult, StatusReport, ValidationReport,
};

describe("docs/specs/pipeline.md ⇄ src/schemas.ts", () => {
  const examples = specExamples();

  it("has exactly the json examples the schemas expect", () => {
    // Fails when a shape gains a spec example with no schema, or loses the example that pins it.
    expect([...examples.keys()].sort()).toEqual(Object.keys(SCHEMAS).sort());
  });

  for (const [name, schema] of Object.entries(SCHEMAS)) {
    it(`${name} parses its spec example and round-trips`, () => {
      const example = examples.get(name);
      expect(example, `no json example under ## ${name}`).toBeDefined();
      const parsed = schema.parse(example);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(example);
    });
  }
});

describe("the invariants the contracts are here to enforce", () => {
  const base = Verdict.parse(specExamples().get("Verdict"));

  it("rejects a Verdict that claims a survival its own fields don't support", () => {
    expect(Verdict.safeParse({ ...base, tautological: true }).success).toBe(false);
    expect(Verdict.safeParse({ ...base, mutation: { ...base.mutation!, killed: 0, score: 0 } }).success).toBe(false);
    expect(Verdict.safeParse({ ...base, survived: false }).success).toBe(false);
  });

  it("accepts a failed Verdict where survived follows the same rule", () => {
    const failed = { ...base, survived: false, tautological: true };
    expect(Verdict.safeParse(failed).success).toBe(true);
    expect(survives(failed)).toBe(false);
  });

  it("survives() is unmoved by a stage that never ran", () => {
    expect(survives({ ...base, mutation: null })).toBe(false);
  });

  it("truncates errors at 2048 chars rather than carrying a whole compiler log", () => {
    expect(Verdict.safeParse({ ...base, survived: false, compile_ok: false, error: "x".repeat(2048) }).success).toBe(true);
    expect(Verdict.safeParse({ ...base, survived: false, compile_ok: false, error: "x".repeat(2049) }).success).toBe(false);
  });

  it("refuses a BatchResult that spent Claude tokens on worker inference", () => {
    const batch = BatchResult.parse(specExamples().get("BatchResult"));
    const spent = { ...batch, stats: { ...batch.stats, claude_tokens: { ...batch.stats.claude_tokens, workers: 1 } } };
    expect(BatchResult.safeParse(spent).success).toBe(false);
  });

  it("refuses a Candidate generated above temperature 0", () => {
    const candidate = Candidate.parse(specExamples().get("Candidate"));
    expect(Candidate.safeParse({ ...candidate, worker: { ...candidate.worker, temperature: 0.2 } }).success).toBe(false);
  });
});
