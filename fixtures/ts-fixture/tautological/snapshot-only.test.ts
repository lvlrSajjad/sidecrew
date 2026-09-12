// Cheap pass #3: pin today's output, bug and all. Research §E: mutation testing does not catch this.
import { describe, it, expect } from "vitest";
import { chunk } from "../src/arrays";

describe("chunk", () => {
  it("matches the snapshot", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toMatchInlineSnapshot(`
      [
        [
          1,
          2,
        ],
        [
          3,
          4,
        ],
        [
          5,
        ],
      ]
    `);
  });
});
