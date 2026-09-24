// `sidecrew query diagnostics` against a real `tsc`. SIDECREW_SLOW=1 to include.
import { describe, expect, it } from "vitest";
import { query } from "../src/query.js";

const SLOW = process.env.SIDECREW_SLOW === "1";

describe.skipIf(!SLOW)("query diagnostics on a real compiler", () => {
  it("lists the fixture's three planted errors under its own configuration", async () => {
    const a = await query("diagnostics", "fixtures/fix-fixture");
    if (a.kind !== "diagnostics") throw new Error("wrong kind");
    expect(a.items.map((d) => `${d.file} ${d.code}`).sort()).toEqual([
      "src/cart.ts TS18048", "src/rates.ts TS2538", "src/report.ts TS2345",
    ]);
    expect(a.added_only).toBe(false);
  }, 120_000);

  it("lists only what a flag adds, filtered by code", async () => {
    // The fixture is strict and has no unused locals, so the honest answer is an empty list — and it
    // must not be the three baseline errors wearing the flag's name.
    const a = await query("diagnostics", "fixtures/fix-fixture", { flag: "--noUnusedLocals" });
    expect(a.items).toEqual([]);
    expect(a.total).toBe(0);
  }, 120_000);
});
