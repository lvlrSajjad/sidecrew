import { describe, it, expect } from "vitest";
import { lineTotal, roundTo, subtotal } from "../src/money";

describe("money", () => {
  it("rounds to the requested number of places", () => {
    expect(roundTo(1.005, 2)).toBe(1);
    expect(roundTo(2.345, 2)).toBe(2.35);
  });

  it("treats a missing quantity as one", () => {
    expect(lineTotal({ label: "pen", amount: 1.5 })).toBe(1.5);
    expect(lineTotal({ label: "pen", amount: 1.5, quantity: 3 })).toBe(4.5);
  });

  it("sums the lines", () => {
    expect(subtotal([{ label: "a", amount: 1.11 }, { label: "b", amount: 2.22, quantity: 2 }])).toBe(5.55);
  });
});
