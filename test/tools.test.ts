// ADR-0088: sidecrew's own pinned Stryker, and a per-run copy of it wired to the project's own tools.
//
// Fast and offline: the cache and the project are built by hand in a temp directory. The real install
// is exercised by `sidecrew tools install` and the slow verifier suites, which need network once.
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareFingerprints, fingerprintProject } from "../src/integrity.js";
import {
  esmEntry, PROJECT_OWNED, prepareStryker, STRYKER_PACKAGES, STRYKER_VERSION, strykerDir, strykerStatus, toolStatusMessage,
} from "../src/tools.js";
import { VerifierSetupError } from "../src/verifier/shared.js";

const temps: string[] = [];
const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const pkg = (dir: string, name: string, version: string, extra: Record<string, unknown> = {}): void => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "package.json"), JSON.stringify({ name, version, ...extra }));
};

/** A cache that looks like `sidecrew tools install` left it, under a temp SIDECREW_TOOLS_DIR. */
const fakeCache = (opts: { leak?: string } = {}): NodeJS.ProcessEnv => {
  const env = { SIDECREW_TOOLS_DIR: temp("sidecrew-tools-") };
  const modules = join(strykerDir(env), "node_modules");
  for (const p of STRYKER_PACKAGES) {
    pkg(modules, p, STRYKER_VERSION, { exports: { ".": { import: "./dist/src/index.js" } } });
    mkdirSync(join(modules, p, "dist", "src"), { recursive: true });
    writeFileSync(join(modules, p, "dist", "src", "index.js"), "export {};\n");
  }
  mkdirSync(join(modules, ".bin"), { recursive: true });
  writeFileSync(join(modules, ".bin", "stryker"), "#!/bin/sh\n");
  if (opts.leak) pkg(modules, opts.leak, "7.0.2");
  return env;
};

/** A project with its own compiler and runner, and nothing of Stryker's. */
const fakeProject = (runners: string[] = ["jest"]): string => {
  const dir = temp("sidecrew-proj-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }));
  for (const r of ["typescript", ...runners]) pkg(join(dir, "node_modules"), r, "5.0.0");
  return dir;
};

describe("strykerStatus", () => {
  it("is missing on a machine that never ran `sidecrew tools install`, and says how to fix it", () => {
    const s = strykerStatus({ SIDECREW_TOOLS_DIR: temp("sidecrew-tools-") });
    expect(s.ok).toBe(false);
    expect(s.missing).toEqual([...STRYKER_PACKAGES]);
    expect(toolStatusMessage(s)).toContain("sidecrew tools install");
  });

  it("is ok on a complete cache at the pinned version", () => {
    expect(strykerStatus(fakeCache())).toMatchObject({ ok: true, missing: [], leaked: [] });
  });

  it("refuses a cache holding a tool the project must supply — the spike's typescript 7.0.2", () => {
    for (const leak of PROJECT_OWNED) {
      const s = strykerStatus(fakeCache({ leak }));
      expect(s.ok, leak).toBe(false);
      expect(s.leaked).toEqual([leak]);
      expect(toolStatusMessage(s)).toContain("must come from the project");
    }
  });
});

describe("prepareStryker", () => {
  it("links the project's own typescript and runner into a per-run copy, and names exactly two plugins", async () => {
    const env = fakeCache();
    const project = fakeProject(["jest"]);
    const run = await prepareStryker(project, "jest", { env });
    try {
      for (const own of ["typescript", "jest"]) {
        expect(readlinkSync(join(run.dir, "node_modules", own))).toBe(realpathSync(join(project, "node_modules", own)));
      }
      expect(existsSync(join(run.dir, "node_modules", "vitest"))).toBe(false);
      expect(run.plugins).toEqual([
        join(run.dir, "node_modules/@stryker-mutator/jest-runner/dist/src/index.js"),
        join(run.dir, "node_modules/@stryker-mutator/typescript-checker/dist/src/index.js"),
      ]);
      expect(run.bin).toBe(join(run.dir, "node_modules/.bin/stryker"));
      // The cache itself is never linked: two runs on two projects must not share one set of links.
      expect(existsSync(join(strykerDir(env), "node_modules", "typescript"))).toBe(false);
    } finally {
      await run.cleanup();
    }
    expect(existsSync(run.dir)).toBe(false);
  });

  it("leaves the project exactly as it found it", async () => {
    const project = fakeProject(["vitest"]);
    const before = await fingerprintProject(project);
    const run = await prepareStryker(project, "vitest", { env: fakeCache() });
    await run.cleanup();
    expect(compareFingerprints(before, await fingerprintProject(project))).toEqual([]);
  });

  it("refuses, as a setup error, a project with no compiler or runner of its own — sidecrew supplies neither", async () => {
    const env = fakeCache();
    await expect(prepareStryker(fakeProject([]), "jest", { env })).rejects.toThrow(VerifierSetupError);
    await expect(prepareStryker(fakeProject([]), "jest", { env })).rejects.toThrow(/no jest of its own/);
    const noTs = temp("sidecrew-proj-");
    writeFileSync(join(noTs, "package.json"), "{}");
    pkg(join(noTs, "node_modules"), "jest", "29.0.0");
    await expect(prepareStryker(noTs, "jest", { env })).rejects.toThrow(/no typescript of its own/);
  });

  it("refuses a missing or leaky cache rather than downloading anything", async () => {
    await expect(prepareStryker(fakeProject(), "jest", { env: { SIDECREW_TOOLS_DIR: temp("sidecrew-tools-") } }))
      .rejects.toThrow(/sidecrew tools install/);
    await expect(prepareStryker(fakeProject(), "jest", { env: fakeCache({ leak: "vitest" }) }))
      .rejects.toThrow(/must come from the project/);
  });
});

describe("esmEntry", () => {
  it("reads the import condition, then module, then main", () => {
    expect(esmEntry({ exports: { ".": { import: "./esm.js", require: "./cjs.js" } } })).toBe("./esm.js");
    expect(esmEntry({ module: "./m.js", main: "./c.js" })).toBe("./m.js");
    expect(esmEntry({ main: "./c.js" })).toBe("./c.js");
    expect(esmEntry({})).toBeNull();
  });
});
