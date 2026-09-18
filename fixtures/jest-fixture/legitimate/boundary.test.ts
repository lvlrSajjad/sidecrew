// A real boundary test of `commonPrefix`, under Jest. Survives: compiles, passes, kills a mutant.
import { describe, it, expect } from "@jest/globals";
import { commonPrefix } from "../src/strings";

describe("commonPrefix", () => {
  it("returns an empty string when the first characters differ", () => {
    expect(commonPrefix("abc", "xyz")).toBe("");
  });

  it("returns the whole of the shorter string when one is a prefix of the other", () => {
    expect(commonPrefix("ab", "abcd")).toBe("ab");
  });

  it("returns an empty string when either side is empty", () => {
    expect(commonPrefix("", "abc")).toBe("");
    expect(commonPrefix("abc", "")).toBe("");
  });
});
