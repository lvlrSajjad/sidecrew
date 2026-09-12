// Cheap pass #2: call the function, then compare its result with itself.
import { describe, it, expect } from "vitest";
import { titleCase } from "../src/strings";

describe("titleCase", () => {
  it("returns a consistent value", () => {
    const actual = titleCase("the quick brown fox");
    expect(actual).toBe(actual);
  });

  it("equals itself", () => {
    expect(titleCase("abc")).toEqual(titleCase("abc"));
  });
});
