import { describe, it, expect } from "vitest";
import { convert, rateFor } from "../src/rates";

const RATES = { EUR: 1.1, GBP: 0.85 };

describe("rates", () => {
  it("looks a rate up", () => {
    expect(rateFor(RATES, "EUR")).toBe(1.1);
  });

  // The behaviour the planted TS2538 must not change: an unknown or missing code is zero, not a throw.
  it("is zero for a code it does not know", () => {
    expect(rateFor(RATES, "XXX")).toBe(0);
  });

  it("is zero when no code is given at all", () => {
    expect(rateFor(RATES, undefined)).toBe(0);
  });

  it("converts", () => {
    expect(convert(10, RATES, "GBP")).toBe(8.5);
    expect(convert(10, RATES, undefined)).toBe(0);
  });
});
