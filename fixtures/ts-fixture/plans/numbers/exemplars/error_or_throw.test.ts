// shape: error_or_throw — the inputs the contract rejects. Assert the error type and that the message
// names the offending value.
import { describe, it, expect } from "vitest";
import { clamp } from "../src/numbers";

describe("clamp", () => {
  it("throws a RangeError when the bounds are inverted", () => {
    expect(() => clamp(5, 10, 0)).toThrow(RangeError);
  });

  it("names the empty range it was given", () => {
    expect(() => clamp(5, 10, 0)).toThrow("empty range: [10, 0]");
  });

  it("does not throw when the bounds merely touch", () => {
    expect(clamp(5, 3, 3)).toBe(3);
  });
});
