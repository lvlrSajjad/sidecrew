// shape: boundary — the value either side of each limit, and a range with no width. Exact values.
import { describe, it, expect } from "vitest";
import { clamp } from "../src/numbers";

describe("clamp", () => {
  it("leaves a value sitting exactly on the minimum", () => {
    expect(clamp(0, 0, 10)).toBe(0);
  });

  it("leaves a value sitting exactly on the maximum", () => {
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it("returns the only value a single-point range allows", () => {
    expect(clamp(7, 7, 7)).toBe(7);
  });

  it("clamps the value one step outside each limit", () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
