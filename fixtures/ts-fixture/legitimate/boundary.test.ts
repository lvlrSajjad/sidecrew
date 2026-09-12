// shape: boundary — empty input, single element, exact multiple. One test per boundary.
import { describe, it, expect } from "vitest";
import { chunk } from "../src/arrays";

describe("chunk", () => {
  it("returns nothing for an empty array", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it("returns one short run when the array is smaller than the size", () => {
    expect(chunk([1], 3)).toEqual([[1]]);
  });

  it("splits evenly when the size divides the length", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it("leaves the remainder in a short final run", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("rejects a size below one", () => {
    expect(() => chunk([1, 2], 0)).toThrow(RangeError);
  });
});
