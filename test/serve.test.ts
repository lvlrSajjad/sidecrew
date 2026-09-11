import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  memoryGate, serveArgs, workerFiles, alive, readPid, readRecord, serve, stop,
  SERVE_HEADROOM_GB, SIDECREW_DIR,
} from "../src/serve.js";
import { entry } from "../src/models.js";
import { MLX_SERVER_MODULE } from "../src/exec.js";

const model = { key: "test-7b", repo: "org/test-7b", revision: "", ram_gb: 5, licence: "Apache-2.0" };

describe("memoryGate", () => {
  it("lets a worker start when the weights plus headroom fit in free RAM", () => {
    expect(memoryGate(model, { total_gb: 32, free_gb: 5 + SERVE_HEADROOM_GB }).ok).toBe(true);
  });

  it("refuses on free RAM, and names both the shortfall and the way out", () => {
    const gate = memoryGate(model, { total_gb: 32, free_gb: 5 + SERVE_HEADROOM_GB - 0.1 });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/close Xcode/);
  });

  it("is stricter than doctor, because serve is about to load the weights", () => {
    // doctor's KV headroom is 1.5 GB and only degrades; a run that starts into swap poisons every
    // number measured afterwards (research §E), so serve asks for more and says no.
    expect(SERVE_HEADROOM_GB).toBeGreaterThan(1.5);
  });

  it("tells a 16 GB machine it is the api tier rather than to close Xcode — ADR-0009", () => {
    const gate = memoryGate(model, { total_gb: 16, free_gb: 3 });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/api tier/);
    expect(gate.reason).not.toMatch(/close Xcode/);
  });

  it("refuses rather than assumes when memory cannot be read", () => {
    const gate = memoryGate(model, null);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/--force/);
  });
});

describe("serveArgs", () => {
  it("uses the non-deprecated module form", () => {
    // `-m mlx_lm.server` still runs in mlx_lm 0.31 but prints a deprecation notice into the log on
    // every start, and the log is where a failed start has to be readable.
    expect(MLX_SERVER_MODULE).toEqual(["-m", "mlx_lm", "server"]);
    expect(serveArgs("org/repo", 8000).join(" ")).not.toContain("mlx_lm.server");
  });

  it("passes the resolved model argument and the port through unchanged", () => {
    const args = serveArgs("/cache/snapshots/abc", 9123);
    expect(args).toContain("/cache/snapshots/abc");
    expect(args[args.indexOf("--port") + 1]).toBe("9123");
  });
});

describe("workerFiles", () => {
  it("keys every file by port, so two workers never share one", () => {
    const a = workerFiles(8000);
    const b = workerFiles(8001);
    expect(a.pid).toBe(join(SIDECREW_DIR, "worker-8000.pid"));
    expect(new Set([a.pid, a.log, a.record, b.pid, b.log, b.record]).size).toBe(6);
  });
});

describe("alive", () => {
  it("knows this process is running and that pid 1 is not us", () => {
    expect(alive(process.pid)).toBe(true);
    // A pid far above the kernel's range has never existed in this boot.
    expect(alive(4_194_300)).toBe(false);
  });
});

// ── the lifecycle, against a stub that behaves like mlx_lm.server without a model ────────────────

let dir: string;
let stubPython: string;
let port: number;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sidecrew-serve-"));
  stubPython = join(dir, "fake-python");

  // Reads the same `--port` mlx_lm would, answers /v1/models the same way, and otherwise sits there.
  // SIDECREW_PYTHON exists precisely so the interpreter is a seam; this test is what it buys.
  // Behaves like mlx_lm.server in the ways serve depends on: reads --port, answers /v1/models from a
  // catalogue, and — importantly — can be told to answer /v1/models while still refusing to generate,
  // which is the real server's behaviour during model load. SIDECREW_PYTHON exists so the interpreter
  // is a seam; this test is what it buys.
  await writeFile(stubPython, `#!/usr/bin/env node
const { createServer } = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const model = process.argv[process.argv.indexOf("--model") + 1];
const delay = Number(process.env.FAKE_MLX_DELAY_MS ?? 0);
const loadMs = Number(process.env.FAKE_MLX_LOAD_MS ?? 0);
if (process.env.FAKE_MLX_EXIT) { console.error("fake mlx: refusing to start"); process.exit(2); }
const listeningAt = Date.now();
setTimeout(() => {
  createServer((req, res) => {
    if (req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: model }] }));
      return;
    }
    // Still loading: the endpoint answers, generation does not. This is the gap serve must wait out.
    if (Date.now() - listeningAt < loadMs) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("model is still loading");
      return;
    }
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(\`data: \${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}\\n\\n\`);
      res.write(\`data: \${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\\n\\n\`);
      res.end("data: [DONE]\\n\\n");
    });
  }).listen(port, "127.0.0.1");
}, delay);
setInterval(() => {}, 1000);
`);
  await chmod(stubPython, 0o755);

  // A port that was free a moment ago, which the stub will bind.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
});

afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
afterEach(async () => {
  await stop({ port, dir, quiet: true }).catch(() => {});
  delete process.env.SIDECREW_PYTHON;
  delete process.env.FAKE_MLX_EXIT;
  delete process.env.FAKE_MLX_DELAY_MS;
  delete process.env.FAKE_MLX_LOAD_MS;
});

describe("serve → status → stop", () => {
  it("starts a detached worker, waits for it to answer, and records what it started", async () => {
    process.env.SIDECREW_PYTHON = stubPython;
    const record = await serve({ modelKey: entry("qwen2.5-coder-7b-4bit").key, port, dir, quiet: true, force: true, readyTimeoutMs: 20_000 });

    expect(record.port).toBe(port);
    expect(alive(record.pid)).toBe(true);
    expect(await readPid(port, dir)).toBe(record.pid);
    expect((await readRecord(port, dir))?.pid).toBe(record.pid);

    // The worker outlives the call that started it — that is the whole reason serve does not use exec.run.
    const res = await fetch(`http://localhost:${port}/v1/models`);
    expect(res.ok).toBe(true);

    expect(await stop({ port, dir, quiet: true })).toBe(true);
    expect(alive(record.pid)).toBe(false);
    expect(await readPid(port, dir)).toBeNull();
    expect(await readRecord(port, dir)).toBeNull();
  }, 30_000);

  it("writes a log next to the pidfile, and appends across restarts", async () => {
    process.env.SIDECREW_PYTHON = stubPython;
    await serve({ port, dir, quiet: true, force: true, readyTimeoutMs: 20_000 });
    await stop({ port, dir, quiet: true });

    process.env.FAKE_MLX_EXIT = "1";
    await serve({ port, dir, quiet: true, force: true, readyTimeoutMs: 5_000 }).catch(() => {});
    const log = await readFile(workerFiles(port, dir).log, "utf8");
    expect(log).toContain("refusing to start");
  }, 30_000);

  it("cleans up the pidfile when the worker dies before it answers", async () => {
    process.env.SIDECREW_PYTHON = stubPython;
    process.env.FAKE_MLX_EXIT = "1";
    await expect(serve({ port, dir, quiet: true, force: true, readyTimeoutMs: 10_000 }))
      .rejects.toThrow(/exited before it answered|tail -n 40/);
    // A pidfile left behind would make `stop` chase a pid that is gone, or worse, a recycled one.
    expect(await readPid(port, dir)).toBeNull();
  }, 20_000);

  it("waits for the worker to generate, not merely to answer /v1/models", async () => {
    // Measured against the real server: /v1/models answered 1.9 s before the 14B could complete
    // anything, because mlx_lm serves that endpoint from the Hugging Face cache. Returning on it would
    // hand out a worker that cannot yet do the one thing it exists for.
    process.env.SIDECREW_PYTHON = stubPython;
    process.env.FAKE_MLX_LOAD_MS = "2500";

    const startedAt = Date.now();
    await serve({ port, dir, quiet: true, force: true, readyTimeoutMs: 30_000 });
    const waited = Date.now() - startedAt;

    expect(waited).toBeGreaterThanOrEqual(2_400);
    // And when serve returns, a completion works immediately — no wait charged to the first caller.
    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
    });
    expect(res.status).toBe(200);
    await res.text();
  }, 45_000);

  it("says which of the two failures it hit when a listening worker never loads", async () => {
    process.env.SIDECREW_PYTHON = stubPython;
    process.env.FAKE_MLX_LOAD_MS = "600000";
    await expect(serve({ port, dir, quiet: true, force: true, readyTimeoutMs: 3_000 }))
      .rejects.toThrow(/listening but could not generate/);
  }, 30_000);

  it("kills the worker it started when that worker never becomes ready", async () => {
    // Otherwise a failed start leaks a process holding the port and several GB of weights, with its
    // pidfile already deleted — so nothing is left that `sidecrew stop` could find it by.
    process.env.SIDECREW_PYTHON = stubPython;
    process.env.FAKE_MLX_LOAD_MS = "600000";
    await expect(serve({ port, dir, quiet: true, force: true, readyTimeoutMs: 2_000 })).rejects.toThrow();

    // The port is free again, which it would not be if the worker were still listening.
    const probe = createServer();
    await new Promise<void>((r, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => r());
    });
    await new Promise<void>((r) => probe.close(() => r()));
  }, 30_000);

  it("gives up on a worker that never answers, rather than hanging", async () => {
    process.env.SIDECREW_PYTHON = stubPython;
    process.env.FAKE_MLX_DELAY_MS = "60000";
    await expect(serve({ port, dir, quiet: true, force: true, readyTimeoutMs: 1_500 }))
      .rejects.toThrow(/did not answer/);
  }, 20_000);

  it("is idempotent: serving what is already served says so instead of fighting for the port", async () => {
    process.env.SIDECREW_PYTHON = stubPython;
    const first = await serve({ port, dir, quiet: true, force: true, readyTimeoutMs: 20_000 });
    const second = await serve({ port, dir, quiet: true, force: true, readyTimeoutMs: 20_000 });
    expect(second.pid).toBe(first.pid);
  }, 40_000);

  it("refuses to serve a different model on a port that is already taken", async () => {
    process.env.SIDECREW_PYTHON = stubPython;
    await serve({ modelKey: "qwen2.5-coder-7b-4bit", port, dir, quiet: true, force: true, readyTimeoutMs: 20_000 });
    await expect(serve({ modelKey: "qwen2.5-coder-14b-4bit", port, dir, quiet: true, force: true }))
      .rejects.toThrow(/already serves qwen2\.5-coder-7b-4bit/);
  }, 40_000);

  it("refuses to spawn into a port something else already holds", async () => {
    // Without a record there is no pid to manage and no worker to return, and spawning anyway would put
    // a second mlx_lm on a bound port — where it dies in python with an address-in-use traceback.
    const squatter = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "someone-elses-model" }] }));
    });
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", () => r()));
    try {
      process.env.SIDECREW_PYTHON = stubPython;
      await expect(serve({ port, dir, quiet: true, force: true }))
        .rejects.toThrow(/sidecrew did not start it.*--port/s);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  it("refuses to kill a pid that is no longer a worker, and clears the stale file", async () => {
    // A pidfile outlives a reboot, and macOS recycles pids. `stop` signals a whole process group, so
    // trusting a number off disk means the blast radius of a stale file is somebody else's work.
    await mkdir(dir, { recursive: true });
    await writeFile(workerFiles(port, dir).pid, `${process.pid}\n`);

    expect(alive(process.pid)).toBe(true);
    expect(await stop({ port, dir, quiet: true })).toBe(false);

    // It cleaned up rather than killed — this test process is still here to assert that.
    expect(alive(process.pid)).toBe(true);
    expect(await readPid(port, dir)).toBeNull();
  });

  it("reports honestly when there is nothing to stop", async () => {
    expect(await stop({ port, dir, quiet: true })).toBe(false);
  });
});
