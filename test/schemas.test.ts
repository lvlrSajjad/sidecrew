import { describe, it, expect } from "vitest";
import { TestShape } from "../src/schemas.js";

describe("TestShape", () => {
  it("round-trips", () => {
    const s = { kind: "boundary", exemplar: "exemplars/boundary.test.ts", rules: "edge cases" };
    expect(TestShape.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});
