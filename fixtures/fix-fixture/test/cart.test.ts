import { describe, it, expect } from "vitest";
import { discounted } from "../src/cart";

describe("cart", () => {
  it("takes the discount off the subtotal", () => {
    expect(discounted({ lines: [{ label: "a", amount: 10 }], discount: 0.1 })).toBe(9);
  });

  it("charges the full subtotal at a zero discount", () => {
    expect(discounted({ lines: [{ label: "a", amount: 10 }, { label: "b", amount: 5 }], discount: 0 })).toBe(15);
  });
});
