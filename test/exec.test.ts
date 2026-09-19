import { describe, it, expect } from "vitest";
import { run, ok, firstLine, wasTruncated } from "../src/exec.js";
import { stageEnv } from "../src/verifier/ts.js";

describe("run", () => {
  it("reports a successful command", async () => {
    const r = await run("node", ["-e", "process.stdout.write('hi')"]);
    expect(ok(r)).toBe(true);
    expect(r.stdout).toBe("hi");
    expect(r.timedOut).toBe(false);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it("separates the streams and keeps the exit code", async () => {
    const r = await run("node", ["-e", "console.error('boom'); process.exit(3)"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim()).toBe("boom");
  });

  it("answers rather than throws when the binary does not exist", async () => {
    const r = await run("sidecrew-does-not-exist", ["--version"]);
    expect(r.code).toBeNull();
    expect(r.stderr).toMatch(/ENOENT/);
  });

  it("kills the whole process group on timeout, not just the child we hold", async () => {
    // The parent ignores SIGTERM and outlives the timeout; only a group kill ends the grandchild too.
    const script = `
      const { spawn } = require('node:child_process');
      const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.stdout.write(String(kid.pid));
      setInterval(() => {}, 1000);
    `;
    const r = await run("node", ["-e", script], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();

    const grandchild = Number(r.stdout.trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    // process.kill(pid, 0) throws ESRCH once the pid is gone.
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it("caps each stream instead of holding a whole mutation log in memory", async () => {
    const r = await run("node", ["-e", "process.stdout.write('x'.repeat(50000))"], { maxOutputBytes: 1000 });
    expect(r.stdout).toMatch(/truncated at 1000 bytes$/);
    expect(r.stdout.length).toBeLessThan(2000);
  });

  it("merges env over the parent environment and honours cwd", async () => {
    const r = await run("node", ["-e", "process.stdout.write(process.env.SIDECREW_PROBE + ':' + process.cwd())"], {
      env: { SIDECREW_PROBE: "set" },
      cwd: "/tmp",
    });
    expect(r.stdout).toMatch(/^set:/);
    expect(r.stdout).toMatch(/tmp$/);
  });

  it("firstLine picks the first non-empty line of either stream", async () => {
    expect(firstLine(await run("node", ["--version"]))).toMatch(/^v\d+\./);
  });
});

describe("losing output is detectable, not just visible", () => {
  it("says so when a stream was capped, because one caller has to branch on it", () => {
    // `typecheck` reads `tsc --listFiles`, and tsc prints that list AFTER every diagnostic. On a
    // project with more than the cap's worth of errors the list falls off the end — and the ADR-0037
    // guard, which concludes "tsc never ran" from an empty file list, would then say the opposite of
    // what happened. Measured under ADR-0063: --strictNullChecks on a real service emits 11,412
    // errors over ~2.5 MB against a 1 MB default.
    expect(wasTruncated("all of it")).toBe(false);
    expect(wasTruncated("some of it\n… truncated at 1048576 bytes")).toBe(true);
  });

  it("caps a noisy child and marks it", async () => {
    const r = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(50_000))"], { maxOutputBytes: 1024 });
    expect(ok(r)).toBe(true);
    expect(wasTruncated(r.stdout)).toBe(true);
    expect(r.stdout.length).toBeLessThan(50_000);
  });

  it("does not mark output that fits", async () => {
    const r = await run(process.execPath, ["-e", "process.stdout.write('ok')"], { maxOutputBytes: 1024 });
    expect(r.stdout).toBe("ok");
    expect(wasTruncated(r.stdout)).toBe(false);
  });
});

describe("a stage's environment is not the launcher's — ADR-0052", () => {
  it("removes a variable the caller set to undefined, which a spread cannot express", async () => {
    const r = await run(process.execPath, ["-e", "console.log(JSON.stringify(process.env.SIDECREW_PROBE ?? null))"], {
      env: { SIDECREW_PROBE: undefined },
      timeoutMs: 10_000,
    });
    expect(r.stdout.trim()).toBe("null");
  });

  it("keeps a variable the caller set to a value", async () => {
    const r = await run(process.execPath, ["-e", "console.log(process.env.SIDECREW_PROBE)"], {
      env: { SIDECREW_PROBE: "kept" },
      timeoutMs: 10_000,
    });
    expect(r.stdout.trim()).toBe("kept");
  });

  it("strips every npm_* the launcher exported, so a project's cache resolves where the project put it", () => {
    const parent = {
      PATH: "/usr/bin",
      npm_config_cache: "/somewhere/else",
      npm_package_name: "sidecrew",
      INIT_CWD: "/elsewhere",
      NODE: "/some/node",
      HOME: "/Users/someone",
    };
    const env = stageEnv(parent);
    for (const k of ["npm_config_cache", "npm_package_name", "INIT_CWD", "NODE"]) {
      expect(env[k], `${k} must be unset for the child`).toBeUndefined();
      expect(k in env, `${k} must be present as an explicit undefined, or the spread will not remove it`).toBe(true);
    }
    // What the stage adds is unchanged, and what it has no opinion about is left alone.
    expect(env.CI).toBe("true");
    expect(env.NO_COLOR).toBe("1");
    expect("HOME" in env).toBe(false);
  });
});
