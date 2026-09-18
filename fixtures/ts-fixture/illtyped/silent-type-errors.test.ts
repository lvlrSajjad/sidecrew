// A candidate that PASSES and does not type-check. Every error here is silent at runtime, which is the
// whole point: the pass stage cannot catch these, so only the compile stage can (ADR-0037).
import { describe, it, expect } from "vitest";
import { chunk } from "../src/arrays";

const wrong: string = 42;                   // TS2322
const alsoWrong: number = "not a number";   // TS2322

describe("chunk", () => {
  it("splits into chunks", () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1], 1, "extra")).toEqual([[1]]);  // TS2554: too many arguments
  });
});
