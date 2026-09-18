// shape: happy_path — one or two representative inputs, assert the exact return value.
import { describe, it, expect } from "vitest";
import { chunk } from "../src/arrays";

describe("chunk", () => {
  it("splits into runs of the requested size", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it("leaves the last run short when the size does not divide evenly", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
