// shape: error_or_throw — the error type and the message, not just "it threw".
import { describe, it, expect } from "vitest";
import { percentChange } from "../src/numbers";

describe("percentChange", () => {
  it("reports a rise as a positive fraction", () => {
    expect(percentChange(200, 250)).toBe(0.25);
  });

  it("reports a fall as a negative fraction", () => {
    expect(percentChange(200, 150)).toBe(-0.25);
  });

  it("throws a RangeError when the base is zero", () => {
    expect(() => percentChange(0, 10)).toThrow(RangeError);
    expect(() => percentChange(0, 10)).toThrow(/undefined/);
  });

  it("measures against the magnitude of a negative base", () => {
    expect(percentChange(-200, -150)).toBe(0.25);
  });
});
