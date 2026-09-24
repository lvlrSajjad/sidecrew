// `sidecrew recon` against a real `tsc`, on fixtures/fix-fixture. SIDECREW_SLOW=1 to include.
//
// The fixture is `strict: true` with three planted errors, which makes it the one case the fast tests
// cannot reach: the strict family must come back **already on** — read from the compiler's own
// `--showConfig`, not guessed — and the lint-shaped flags must be measured for real.
import { describe, expect, it } from "vitest";
import { recon } from "../src/recon.js";
import { ReconReport } from "../src/schemas.js";

const SLOW = process.env.SIDECREW_SLOW === "1";
const PROJECT = "fixtures/fix-fixture";

describe.skipIf(!SLOW)("recon on a real compiler", () => {
  it("counts the baseline, reads what is already on, and measures the rest", async () => {
    const r = await recon(PROJECT, { flags: ["--strictNullChecks", "--noImplicitAny", "--noUnusedLocals", "--noUnusedParameters"] });
    expect(ReconReport.safeParse(r).success).toBe(true);
    expect(r.config_read).toBe(true);
    // The three planted errors, all in source files.
    expect(r.baseline.errors).toBe(3);
    expect(r.baseline.source.files).toBe(3);
    expect(r.baseline.tests_in_program).toBeGreaterThan(0);
    const by = Object.fromEntries(r.flags.map((f) => [f.flag, f]));
    expect(by["--strictNullChecks"]!.already_on).toBe(true);
    expect(by["--noImplicitAny"]!.already_on).toBe(true);
    for (const flag of ["--noUnusedLocals", "--noUnusedParameters"] as const) {
      expect(by[flag]!.already_on, flag).toBe(false);
      expect(by[flag]!.added, flag).not.toBeNull();
    }
    expect(r.fix_offered).toBe(false);
  }, 120_000);
});
