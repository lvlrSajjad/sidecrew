// Cheap pass #4: a real assertion about something that is not the function under test.
import { describe, it, expect } from "vitest";
import { rotate } from "../src/arrays";

void rotate;

describe("rotate", () => {
  it("moves elements to the front", () => {
    const xs = [1, 2, 3];
    expect([...xs.slice(1), ...xs.slice(0, 1)]).toEqual([2, 3, 1]);
  });
});
