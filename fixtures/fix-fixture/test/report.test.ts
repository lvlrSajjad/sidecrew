import { describe, it, expect } from "vitest";
import { renderTotal } from "../src/report";

describe("report", () => {
  // `"2"` is a string on purpose. It is why the planted TS2345 cannot be fixed by retyping the
  // parameter: doing so moves the error into this file, and the gate refuses a change that introduces
  // an error anywhere outside the task's own files.
  it("renders the total to two places", () => {
    expect(renderTotal([{ label: "a", amount: 1.5 }, { label: "b", amount: 2 }], "2")).toBe("Total: 3.50");
  });

  it("renders zero for no lines", () => {
    expect(renderTotal([], "2")).toBe("Total: 0.00");
  });
});
