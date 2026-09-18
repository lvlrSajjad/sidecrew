// shape: happy_path — one representative input, assert the exact return value.
import { describe, it, expect } from "vitest";
import { slugify } from "../src/strings";

describe("slugify", () => {
  it("lowercases and joins words with dashes", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("strips accents and collapses punctuation", () => {
    expect(slugify("Crème brûlée — no. 2!")).toBe("creme-brulee-no-2");
  });

  it("leaves no leading or trailing dash", () => {
    expect(slugify("  --Sidecrew--  ")).toBe("sidecrew");
  });
});
