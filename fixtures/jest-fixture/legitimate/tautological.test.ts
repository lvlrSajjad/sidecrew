// The cheapest possible pass: it calls nothing and asserts a constant. The detector must catch it
// before the mutation stage is ever paid for (ADR-0006).
import { describe, it, expect } from "@jest/globals";

describe("commonPrefix", () => {
  it("is fine", () => {
    expect(true).toBe(true);
  });
});
