// `sidecrew read` — ADR-0090 §2.2's admission rule, and the reader end to end against a fake worker.
//
// The rule under test is *existence*: a claim reaches the planner only when every quote it cites is —
// byte for byte, or word for word with the layout removed — inside the lines it names, in a file the
// reader was given. Relevance is not tested
// because nothing checks it, by design (ADR-0090 §2.3).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { admit, buildReadPrompt, checkCitation, loadGiven, parseReaderAnswer, read, renderRead } from "../src/read.js";
import { READ_BUDGET, ReadAnswer } from "../src/schemas.js";
import { startFake, type Fake } from "./fake-worker.js";

const FIXTURE = "fixtures/fix-fixture";
const given = loadGiven(FIXTURE, ["src/money.ts", "src/cart.ts"]);
const byPath = new Map(given.map((f) => [f.path, f]));

// src/money.ts line 11 is `  return Math.round(value * factor) / factor;`
const GOOD = { file: "src/money.ts", lines: [9, 12], quote: "Math.round(value * factor) / factor" };

describe("checkCitation — the quote must be where the reader says it is", () => {
  it("admits a verbatim quote inside the cited lines", () => {
    expect(checkCitation(GOOD, byPath)).toMatchObject({ ok: true, citation: { file: "src/money.ts", start_line: 9, end_line: 12 } });
  });

  it("records an exact match as exact", () => {
    expect(checkCitation(GOOD, byPath)).toMatchObject({ ok: true, citation: { match: "exact" } });
  });

  it("admits the same words with the layout taken out, and says so", () => {
    // What the 7B does to a multi-line span: joins the lines and drops the indentation.
    const joined = { ...GOOD, quote: "const factor = 10 ** places; return Math.round(value * factor) / factor;" };
    expect(checkCitation(joined, byPath)).toMatchObject({ ok: true, citation: { match: "normalised" } });
    // And to a comment: drops the markers. money.ts line 8 is `/** Round to \`places\` decimal places. */`.
    const comment = { ...GOOD, lines: [8, 9], quote: "Round to `places` decimal places. */ export function roundTo(" };
    expect(checkCitation(comment, byPath)).toMatchObject({ ok: true, citation: { match: "normalised" } });
  });

  it("refuses elision, a paraphrase, a re-spaced token, and a quote outside its lines", () => {
    expect(checkCitation({ ...GOOD, quote: "export function roundTo(value: number, places: number): number { ... }" }, byPath)).toEqual({ ok: false, reason: "quote_not_found" });
    expect(checkCitation({ ...GOOD, quote: "Math.round(value*factor)/factor" }, byPath)).toEqual({ ok: false, reason: "quote_not_found" });
    expect(checkCitation({ ...GOOD, quote: "rounds the value to places" }, byPath)).toEqual({ ok: false, reason: "quote_not_found" });
    expect(checkCitation({ ...GOOD, lines: [1, 3] }, byPath)).toEqual({ ok: false, reason: "quote_not_found" });
  });

  it("refuses a file it was not given, lines past the end, and a quote too short to mean anything", () => {
    expect(checkCitation({ ...GOOD, file: "src/rates.ts" }, byPath)).toEqual({ ok: false, reason: "file_not_given" });
    expect(checkCitation({ ...GOOD, lines: [9, 9999] }, byPath)).toEqual({ ok: false, reason: "lines_out_of_range" });
    expect(checkCitation({ ...GOOD, lines: [12, 9] }, byPath)).toEqual({ ok: false, reason: "lines_out_of_range" });
    expect(checkCitation({ ...GOOD, quote: "factor" }, byPath)).toEqual({ ok: false, reason: "quote_size" });
  });

  it("does not accept the line-number prefix the prompt shows as part of the file", () => {
    expect(checkCitation({ ...GOOD, lines: [11, 11], quote: "11|   return Math.round(value" }, byPath)).toEqual({ ok: false, reason: "quote_not_found" });
  });
});

describe("admit — a claim is admitted only whole", () => {
  it("drops a claim with one invented citation, keeps the honest one, and counts why", () => {
    const a = admit([
      { claim: "roundTo uses Math.round", cite: [GOOD] },
      { claim: "and also floors", cite: [GOOD, { ...GOOD, quote: "Math.floor(value * factor)" }] },
      { claim: "no evidence at all" },
    ], given);
    expect(a.claims.map((c) => c.claim)).toEqual(["roundTo uses Math.round"]);
    expect(a.refused).toEqual({ quote_not_found: 1, uncited: 1 });
  });

  it("stops at the claim budget and counts the rest as over budget", () => {
    const many = Array.from({ length: READ_BUDGET.max_claims + 3 }, (_, i) => ({ claim: `claim ${i}`, cite: [GOOD] }));
    const a = admit(many, given);
    expect(a.claims).toHaveLength(READ_BUDGET.max_claims);
    expect(a.refused).toEqual({ over_budget: 3 });
  });

  it("refuses a claim longer than the cap — a summary is not checkable", () => {
    expect(admit([{ claim: "x".repeat(READ_BUDGET.max_claim_chars + 1), cite: [GOOD] }], given).refused).toEqual({ claim_too_long: 1 });
  });
});

describe("parseReaderAnswer", () => {
  it("takes fenced or bare JSON, and answers null for anything else", () => {
    expect(parseReaderAnswer('```json\n{"claims": []}\n```')).toEqual([]);
    expect(parseReaderAnswer('Here you go: {"claims": [{"claim": "a"}]} hope it helps')).toEqual([{ claim: "a" }]);
    expect(parseReaderAnswer("I could not find it.")).toBeNull();
    expect(parseReaderAnswer('{"answer": "yes"}')).toBeNull();
  });
});

describe("loadGiven — what a reader may be handed", () => {
  it("refuses more files than the budget, and a path outside the project", () => {
    const eleven = Array.from({ length: READ_BUDGET.max_files + 1 }, (_, i) => `src/f${i}.ts`);
    expect(() => loadGiven(FIXTURE, eleven)).toThrow(/more than a reader is given/);
    expect(() => loadGiven(FIXTURE, ["../package.json"])).toThrow(/outside the project/);
  });

  it("numbers the lines in the prompt and renders every placeholder", async () => {
    const [m] = await buildReadPrompt({ question: "How does rounding work?", files: ["src/money.ts"] }, loadGiven(FIXTURE, ["src/money.ts"]));
    expect(m!.content).toContain("## src/money.ts");
    expect(m!.content).toMatch(/11\| {3}return Math\.round/);
    expect(m!.content).not.toMatch(/\{\{/);
  });
});

describe("read, end to end against a fake worker", () => {
  const fakes: Fake[] = [];
  const dirs: string[] = [];
  afterAll(async () => {
    for (const f of fakes) await f.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  const answerWith = async (text: string) => {
    const f = await startFake({ chunks: [text] });
    fakes.push(f);
    const rawDir = await mkdtemp(join(tmpdir(), "sidecrew-reads-"));
    dirs.push(rawDir);
    const worker = { port: f.port, baseUrl: f.baseUrl, record: null, modelArg: "fake-model", model: "fake-model", revision: "" };
    return read(FIXTURE, { question: "How is a price rounded?", files: ["src/money.ts", "src/cart.ts"] }, { worker, rawDir });
  };

  it("admits the verified claim, drops the invented one, and never carries the invented text", async () => {
    const a = await answerWith(JSON.stringify({ claims: [
      { claim: "roundTo rounds half away from zero with Math.round", cite: [GOOD] },
      { claim: "INVENTED claim that must not reach the planner", cite: [{ ...GOOD, quote: "Math.trunc(value * factor)" }] },
    ] }));
    expect(ReadAnswer.safeParse(a).success).toBe(true);
    expect(a.outcome).toBe("answered");
    expect(a.claims).toHaveLength(1);
    expect(a.refused).toEqual({ quote_not_found: 1 });
    expect(a.claude_tokens).toBe(0);
    expect(JSON.stringify(a)).not.toContain("INVENTED");
    const text = renderRead(a);
    expect(text).toContain("1 claim(s) admitted, 1 refused (quote_not_found 1)");
    expect(text).toContain("src/money.ts:9-12");
    // The planner reads locations, not quotes: the machine checked them.
    expect(text).not.toContain("Math.round(value * factor)");
    expect(a.rendered_chars).toBe(text.length);
    expect(a.raw_path).not.toBeNull();
  });

  it("says nothing_found for an empty answer, and unparsed for prose — neither is a pass", async () => {
    expect((await answerWith('{"claims": []}')).outcome).toBe("nothing_found");
    const prose = await answerWith("The rounding happens in money.ts.");
    expect(prose.outcome).toBe("unparsed");
    expect(prose.claims).toEqual([]);
    expect(renderRead(prose)).toMatch(/read the files yourself/);
  });
});

describe("the ReadAnswer contract", () => {
  it("does not let an answer claim to be answered with nothing admitted, or cite a file it was not given", async () => {
    const f = await startFake({ chunks: [JSON.stringify({ claims: [{ claim: "ok", cite: [GOOD] }] })] });
    const worker = { port: f.port, baseUrl: f.baseUrl, record: null, modelArg: "fake-model", model: "fake-model", revision: "" };
    const a = await read(FIXTURE, { question: "q", files: ["src/money.ts"] }, { worker, rawDir: null });
    await f.close();
    expect(ReadAnswer.safeParse({ ...a, claims: [] }).success).toBe(false);
    const elsewhere = { ...a, claims: [{ claim: "x", citations: [{ ...a.claims[0]!.citations[0]!, file: "src/rates.ts" }] }] };
    expect(ReadAnswer.safeParse(elsewhere).success).toBe(false);
    expect(ReadAnswer.safeParse({ ...a, claude_tokens: 12 }).success).toBe(false);
  });
});
