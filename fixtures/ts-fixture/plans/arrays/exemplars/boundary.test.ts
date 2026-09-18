// shape: boundary — empty input, one element, and a size larger than the input. Exact values.
import { describe, it, expect } from "vitest";
import { chunk } from "../src/arrays";

describe("chunk", () => {
  it("returns no runs for an empty array", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it("returns one run of one for a single element", () => {
    expect(chunk([1], 1)).toEqual([[1]]);
  });

  it("returns the whole array as one run when the size exceeds it", () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });

  it("returns one run per element when the size is one", () => {
    expect(chunk([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
  });
});
