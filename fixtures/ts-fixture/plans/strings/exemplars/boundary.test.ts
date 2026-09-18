// shape: boundary — empty input, one character, nothing usable. One test per boundary.
import { describe, it, expect } from "vitest";
import { slugify } from "../src/strings";

describe("slugify", () => {
  it("returns an empty string for an empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("keeps a single usable character", () => {
    expect(slugify("A")).toBe("a");
  });

  it("returns an empty string when nothing survives the filter", () => {
    expect(slugify("!!!")).toBe("");
  });

  it("collapses a run of separators to one dash", () => {
    expect(slugify("a   b")).toBe("a-b");
  });
});
