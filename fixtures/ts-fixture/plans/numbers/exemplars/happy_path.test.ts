// shape: happy_path — one or two representative inputs, assert the exact return value.
import { describe, it, expect } from "vitest";
import { clamp } from "../src/numbers";

describe("clamp", () => {
  it("returns a value that is already inside the range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("pulls a value below the range up to the minimum", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });

  it("pulls a value above the range down to the maximum", () => {
    expect(clamp(42, 0, 10)).toBe(10);
  });
});
