// The orphan-sandbox sweep — housekeeping for unattended mode, and the one piece of this project that
// deletes directories recursively.
//
// Every test here is about **what it refuses to touch**. A run removes its own sandbox in a `finally`,
// so orphans come from runs that were killed — which unattended mode makes ordinary. Phase 11b lost
// about 4.5 GB to nine of them in an afternoon, on a machine that was already thrashing.
//
// No gate, no worker, no toolchain: temp directories and clocks.
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findOrphanSandboxes, sweepOrphanSandboxes } from "../src/change.js";
import { removeSandbox } from "../src/verifier/shared.js";

const scratch: string[] = [];
afterAll(async () => { for (const d of scratch) await rm(d, { recursive: true, force: true }); });

const root = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "sidecrew-sweep-root-"));
  scratch.push(d);
  return d;
};

/** A directory of the given name, aged by backdating its mtime. */
const aged = async (base: string, name: string, hours: number, bytes = 64): Promise<string> => {
  const p = join(base, name);
  await mkdir(p, { recursive: true });
  await writeFile(join(p, "file.txt"), "x".repeat(bytes), "utf8");
  const when = new Date(Date.now() - hours * 3_600_000);
  await utimes(p, when, when);
  return p;
};

describe("findOrphanSandboxes", () => {
  it("finds a step sandbox and a task clone, and nothing else in the directory", async () => {
    const base = await root();
    await aged(base, "sidecrew-fix-abc", 24);
    await aged(base, "sidecrew-task-def", 24);
    await aged(base, "some-other-tool-xyz", 24);
    await aged(base, "important-data", 24);

    const found = await findOrphanSandboxes(12, base);
    expect(found.map((o) => o.path.split("/").pop()).sort()).toEqual(["sidecrew-fix-abc", "sidecrew-task-def"]);
  });

  it("will not touch anything younger than the threshold — the property that makes it safe", async () => {
    // Two runs share a machine routinely, and a live step sandbox is written only at step boundaries,
    // which are tens of minutes apart. So recency cannot distinguish "in use" from "idle", and age is
    // the only honest discriminator. A sweep that guessed would delete a running experiment's sandbox.
    const base = await root();
    await aged(base, "sidecrew-fix-live", 1);
    await aged(base, "sidecrew-fix-stale", 48);

    const found = await findOrphanSandboxes(12, base);
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toContain("stale");
  });

  it("does not follow the node_modules symlink when sizing, or when deleting through it", async () => {
    // Every sandbox symlinks the project's `node_modules`. Following it would report the project's
    // dependencies as the sandbox's own size — and invite a future version of this to delete through it.
    const base = await root();
    const real = await root();
    await writeFile(join(real, "big.bin"), "y".repeat(50_000), "utf8");

    const sandbox = await aged(base, "sidecrew-fix-linked", 24, 100);
    await symlink(real, join(sandbox, "node_modules"), "dir");
    // Re-age it: creating the symlink touched the parent's mtime and made it young again. That is not
    // an inconvenience, it is the safety property under test elsewhere in this file — anything a run is
    // still writing into stays young and therefore untouchable.
    const when = new Date(Date.now() - 24 * 3_600_000);
    await utimes(sandbox, when, when);

    const found = await findOrphanSandboxes(12, base);
    expect(found).toHaveLength(1);
    expect(found[0]!.bytes).toBeLessThan(1_000);

    await sweepOrphanSandboxes(found);
    expect(existsSync(sandbox)).toBe(false);
    // The symlink's target survives. This is the assertion that matters most in the file.
    expect(existsSync(join(real, "big.bin"))).toBe(true);
  });

  it("returns nothing for a directory that does not exist, rather than throwing", async () => {
    expect(await findOrphanSandboxes(12, "/nowhere/at/all")).toEqual([]);
  });

  it("sorts biggest first, because the point is reclaiming disk", async () => {
    const base = await root();
    await aged(base, "sidecrew-fix-small", 24, 10);
    await aged(base, "sidecrew-fix-large", 24, 10_000);
    const found = await findOrphanSandboxes(12, base);
    expect(found[0]!.path).toContain("large");
  });
});

describe("sweepOrphanSandboxes", () => {
  it("re-checks the prefix at the point of deletion, and ignores a path it was wrongly handed", async () => {
    // It removes directories recursively, so the cost of being handed a wrong path once is unbounded.
    // The list it is given is not trusted just because this module produced the last one.
    const base = await root();
    const notOurs = await aged(base, "precious-data", 48);
    const ours = await aged(base, "sidecrew-fix-ok", 48);

    const removed = await sweepOrphanSandboxes([
      { path: notOurs, ageHours: 48, bytes: 1 },
      { path: ours, ageHours: 48, bytes: 1 },
    ]);

    expect(removed).toHaveLength(1);
    expect(existsSync(notOurs)).toBe(true);
    expect(existsSync(ours)).toBe(false);
  });

  it("survives a sandbox it cannot delete, because that is the machine's problem (ADR-0056)", async () => {
    const base = await root();
    const gone = join(base, "sidecrew-fix-vanished");
    const removed = await sweepOrphanSandboxes([{ path: gone, ageHours: 48, bytes: 1 }]);
    // `rm --force` treats a missing path as done; what matters is that it did not throw.
    expect(removed.map((o) => o.path)).toEqual([gone]);
  });
});

describe("removeSandbox — the teardown that must not throw away a finished verdict", () => {
  it("removes a populated tree, and is silent about one that is already gone", async () => {
    // The contract, not the race. `verifyChange` removes its per-task sandbox in a `finally`, so an
    // exception here propagates INSTEAD of the verdict already computed — a completed evaluation
    // becomes "the gate could not run at all". Two 25-run measurements died at run 9 on ENOTEMPTY
    // before that was understood, on two different projects.
    const dir = await mkdtemp(join(tmpdir(), "sidecrew-fix-removal-"));
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await writeFile(join(dir, "a", "b", "f.txt"), "x", "utf8");
    await removeSandbox(dir);
    expect(existsSync(dir)).toBe(false);

    // `force` already covers ENOENT; asserted so that a future rewrite cannot quietly drop it.
    await expect(removeSandbox(join(tmpdir(), "sidecrew-fix-never-existed"))).resolves.toBeUndefined();
  });
});
