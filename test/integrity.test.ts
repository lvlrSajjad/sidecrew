// ADR-0088's second rule: after the job the project must be intact — and a machine says so.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareFingerprints, fingerprintProject, ProjectModifiedError, withIntactProject } from "../src/integrity.js";

const temps: string[] = [];
afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A committed git project with a yarn lockfile — project-a's layout, which a package-lock-only check misses. */
const project = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "sidecrew-intact-"));
  temps.push(dir);
  writeFileSync(join(dir, "package.json"), '{"name":"p"}\n');
  writeFileSync(join(dir, "yarn.lock"), "# lock\n");
  writeFileSync(join(dir, "index.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  mkdirSync(join(dir, "node_modules", "jest"), { recursive: true });
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
};

const changesAfter = async (dir: string, act: () => void): Promise<string[]> => {
  const before = await fingerprintProject(dir);
  act();
  return compareFingerprints(before, await fingerprintProject(dir));
};

describe("fingerprintProject", () => {
  it("is stable when nothing happened", async () => {
    expect(await changesAfter(project(), () => {})).toEqual([]);
  });

  it("sees every kind of change the rule names", async () => {
    const d = project();
    expect(await changesAfter(d, () => writeFileSync(join(d, "index.ts"), "export const a = 2;\n"))).toContain(
      "git status changed — a file was created, modified or deleted in the project");
    expect(await changesAfter(d, () => writeFileSync(join(d, "stray.txt"), "x"))).toHaveLength(1);
    expect(await changesAfter(d, () => writeFileSync(join(d, "yarn.lock"), "# changed\n"))).toContain("yarn.lock changed");
    expect(await changesAfter(d, () => writeFileSync(join(d, "package-lock.json"), "{}"))).toContain("package-lock.json appeared");
    // node_modules is gitignored, so git status cannot see this — the listing can.
    expect(await changesAfter(d, () => mkdirSync(join(d, "node_modules", "@stryker-mutator"))))
      .toEqual(["node_modules gained or lost a top-level entry"]);
    expect(await changesAfter(d, () => writeFileSync(join(d, "node_modules", ".bin", "stryker"), "")))
      .toEqual(["node_modules/.bin gained or lost an executable"]);
  });

  it("ignores sidecrew's own output directory and nothing else", async () => {
    const d = project();
    expect(await changesAfter(d, () => {
      mkdirSync(join(d, ".sidecrew", "runs"), { recursive: true });
      writeFileSync(join(d, ".sidecrew", "runs", "r.json"), "{}");
    })).toEqual([]);
    expect(await changesAfter(d, () => writeFileSync(join(d, ".sidecrewish"), ""))).not.toEqual([]);
  });

  it("is scoped to the project's own directory inside a larger repository", async () => {
    // Found by this check's first run: the fixtures sit inside sidecrew's own repository, and `git status`
    // from a fixture reported every file a parallel test wrote anywhere in the repo as a change to it.
    const repo = project();
    const pkgDir = join(repo, "packages", "p");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), "{}");
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "pkg"], { stdio: "ignore" });
    expect(await changesAfter(pkgDir, () => writeFileSync(join(repo, "sibling.txt"), "x"))).toEqual([]);
    expect(await changesAfter(pkgDir, () => writeFileSync(join(pkgDir, "mine.txt"), "x"))).not.toEqual([]);
    expect(await changesAfter(pkgDir, () => {
      mkdirSync(join(pkgDir, ".sidecrew"), { recursive: true });
      writeFileSync(join(pkgDir, ".sidecrew", "r.json"), "{}");
    })).toEqual([]);
  });

  it("still fingerprints manifests and node_modules in a project that is not a git repository", async () => {
    const d = mkdtempSync(join(tmpdir(), "sidecrew-intact-"));
    temps.push(d);
    writeFileSync(join(d, "package.json"), "{}");
    const fp = await fingerprintProject(d);
    expect(fp.head).toBeNull();
    expect(await changesAfter(d, () => unlinkSync(join(d, "package.json")))).toContain("package.json was deleted");
  });
});

describe("withIntactProject", () => {
  it("returns the job's result when the project is untouched", async () => {
    expect(await withIntactProject(project(), async () => 42)).toBe(42);
  });

  it("fails loudly, naming what changed, when the job touched the project", async () => {
    const d = project();
    const job = withIntactProject(d, async () => { writeFileSync(join(d, "yarn.lock"), "# edited\n"); return 1; });
    await expect(job).rejects.toThrow(ProjectModifiedError);
    await expect(withIntactProject(d, async () => { writeFileSync(join(d, "yarn.lock"), "# again\n"); })).rejects.toThrow(/yarn\.lock changed/);
  });

  it("lets the job's own error through and reports the breach beside it, never instead of it (ADR-0085)", async () => {
    const d = project();
    const said: string[] = [];
    await expect(withIntactProject(d, async () => {
      writeFileSync(join(d, "index.ts"), "broken");
      throw new Error("the job's own failure");
    }, (l) => said.push(l))).rejects.toThrow("the job's own failure");
    expect(said.join("\n")).toContain("must leave a project exactly as it found it");
  });
});
