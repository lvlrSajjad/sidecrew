import { describe, it, expect } from "vitest";
import { run, ok, firstLine } from "../src/exec.js";

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
