import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  awaitMemory, memoryGate, serveArgs, sidecrewDir, workerFiles, alive, readPid, readRecord, serve, stop,
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

  it("refuses under kernel memory pressure however free the machine claims to be — ADR-0026", () => {
    // ADR-0011 from the direction Phase 6 found it: under pressure macOS compresses and evicts, so
    // vm_stat's reclaimable pages go *up* while the machine thrashes. `free_gb ≥ need` is necessary and
    // not sufficient, and the kernel's own level is the half that knows.
    const plenty = { total_gb: 32, free_gb: 20 };
    expect(memoryGate(model, plenty, "normal").ok).toBe(true);
    expect(memoryGate(model, plenty, "warn").ok).toBe(false);
    expect(memoryGate(model, plenty, "critical").ok).toBe(false);
    expect(memoryGate(model, plenty, "warn").reason).toMatch(/compresses pages/);
  });

  it("does not treat an unreadable pressure level as normal, or as a refusal", () => {
    // "unknown" is what a non-macOS machine and a missing sysctl both give. Guessing "warn" would refuse
    // every run on a machine with plenty of room; guessing "normal" would claim a check that never ran.
    // Neither: the free-RAM half still decides, and the reason says only what was measured.
    const gate = memoryGate(model, { total_gb: 32, free_gb: 20 }, "unknown");
    expect(gate.ok).toBe(true);
    expect(gate.reason).not.toMatch(/pressure/);
  });

  it("points at --wait now that waiting is a thing it can do", () => {
    expect(memoryGate(model, { total_gb: 32, free_gb: 1 }).reason).toMatch(/--wait/);
  });
});

describe("awaitMemory", () => {
  it("asks once and refuses when there is nothing to wait for", async () => {
    // waitMs 0 is the behaviour every caller had before Phase 7: ask the machine, take the answer.
    const huge = { key: "impossible", repo: "org/impossible", revision: "", ram_gb: 1_000_000, licence: "MIT" };
    const gate = await awaitMemory(huge);
    expect(gate.ok).toBe(false);
  });

  it("keeps asking until the deadline, and says it is waiting", async () => {
    const huge = { key: "impossible", repo: "org/impossible", revision: "", ram_gb: 1_000_000, licence: "MIT" };
    const waits: number[] = [];
    const startedAt = Date.now();
    const gate = await awaitMemory(huge, { waitMs: 400, pollMs: 50, onWait: (ms) => waits.push(ms) });
    // It never lowers the bar — a queue that eventually says yes to a machine with no room would be a
    // gate with a timeout rather than a gate.
    expect(gate.ok).toBe(false);
    expect(waits.length).toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);
  }, 10_000);
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
    const a = workerFiles(8000, SIDECREW_DIR);
    const b = workerFiles(8001, SIDECREW_DIR);
    expect(a.pid).toBe(join(SIDECREW_DIR, "worker-8000.pid"));
    expect(new Set([a.pid, a.log, a.record, b.pid, b.log, b.record]).size).toBe(6);
  });
});

describe("sidecrewDir — ADR-0029", () => {
  it("prefers SIDECREW_DIR, because two different trees is the case walking up cannot solve", () => {
    // A tool run against somebody else's repo has its worker state in one tree and its target in
    // another. Nothing above the target leads to the worker record, so there has to be a way to say it.
    expect(sidecrewDir("/anywhere", { SIDECREW_DIR: "/state/.sidecrew" })).toBe("/state/.sidecrew");
  });

  it("finds the nearest .sidecrew at or above the directory it is asked about", () => {
    // `serve` at a repo root and `run` in one of its workspaces is the common case, and it used to mean
    // the second found no record — which used to mean it guessed.
    expect(sidecrewDir(process.cwd(), {})).toBe(join(process.cwd(), SIDECREW_DIR));
    expect(sidecrewDir(join(process.cwd(), "src", "verifier"), {})).toBe(join(process.cwd(), SIDECREW_DIR));
  });

  it("falls back to a relative .sidecrew where a fresh serve would create one", () => {
    expect(sidecrewDir("/", {})).toBe(SIDECREW_DIR);
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

// `allowUnpinned: true` throughout: these are lifecycle tests, and on a machine with an empty Hugging
// Face cache — every CI runner — `resolveForServe` cannot honour the pin and ADR-0027 refuses to start.
// The refusal has its own test below; making it a precondition of the other nine would test it nine
// times and the lifecycle zero.
describe("serve → status → stop", () => {
  it("starts a detached worker, waits for it to answer, and records what it started", async () => {
    process.env.SIDECREW_PYTHON = stubPython;
    const record = await serve({ modelKey: entry("qwen2.5-coder-7b-4bit").key, port, dir, quiet: true, force: true, allowUnpinned: true, readyTimeoutMs: 20_000 });

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
    await serve({ port, dir, quiet: true, force: true, allowUnpinned: true, readyTimeoutMs: 20_000 });
    await stop({ port, dir, quiet: true });

    process.env.FAKE_MLX_EXIT = "1";
    await serve({ port, dir, quiet: true, force: true, allowUnpinned: true, readyTimeoutMs: 5_000 }).catch(() => {});
    const log = await readFile(workerFiles(port, dir).log, "utf8");
    expect(log).toContain("refusing to start");
  }, 30_000);

  it("cleans up the pidfile when the worker dies before it answers", async () => {
    process.env.SIDECREW_PYTHON = stubPython;
    process.env.FAKE_MLX_EXIT = "1";
    await expect(serve({ port, dir, quiet: true, force: true, allowUnpinned: true, readyTimeoutMs: 10_000 }))
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
    await serve({ port, dir, quiet: true, force: true, allowUnpinned: true, readyTimeoutMs: 30_000 });
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
    await expect(serve({ port, dir, quiet: true, force: true, allowUnpinned: true, readyTimeoutMs: 3_000 }))
      .rejects.toThrow(/listening but could not generate/);
  }, 30_000);

  it("kills the worker it started when that worker never becomes ready", async () => {
    // Otherwise a failed start leaks a process holding the port and several GB of weights, with its
    // pidfile already deleted — so nothing is left that `sidecrew stop` could find it by.
    process.env.SIDECREW_PYTHON = stubPython;
    process.env.FAKE_MLX_LOAD_MS = "600000";
    await expect(serve({ port, dir, quiet: true, force: true, allowUnpinned: true, readyTimeoutMs: 2_000 })).rejects.toThrow();

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
    await expect(serve({ port, dir, quiet: true, force: true, allowUnpinned: true, readyTimeoutMs: 1_500 }))
      .rejects.toThrow(/did not answer/);
  }, 20_000);

  it("is idempotent: serving what is already served says so instead of fighting for the port", async () => {
    process.env.SIDECREW_PYTHON = stubPython;
    const first = await serve({ port, dir, quiet: true, force: true, allowUnpinned: true, readyTimeoutMs: 20_000 });
    const second = await serve({ port, dir, quiet: true, force: true, allowUnpinned: true, readyTimeoutMs: 20_000 });
    expect(second.pid).toBe(first.pid);
  }, 40_000);

  it("refuses to serve a different model on a port that is already taken", async () => {
    process.env.SIDECREW_PYTHON = stubPython;
    await serve({ modelKey: "qwen2.5-coder-7b-4bit", port, dir, quiet: true, force: true, allowUnpinned: true, readyTimeoutMs: 20_000 });
    await expect(serve({ modelKey: "qwen2.5-coder-14b-4bit", port, dir, quiet: true, force: true, allowUnpinned: true }))
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
      await expect(serve({ port, dir, quiet: true, force: true, allowUnpinned: true }))
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

describe("the pin is a refusal, not a warning — ADR-0027", () => {
  // An empty Hugging Face cache is the strongest version of unpinned: mlx_lm would download whatever
  // `main` is today, and two survival rates taken a week apart would not be comparable with nothing
  // saying so. `HF_HUB_CACHE` is the seam `hubCacheDir` reads, so this needs no network and no weights.
  let emptyCache: string;

  beforeAll(async () => { emptyCache = await mkdtemp(join(tmpdir(), "sidecrew-nocache-")); });
  afterAll(async () => { await rm(emptyCache, { recursive: true, force: true }); });
  afterEach(() => { delete process.env.HF_HUB_CACHE; });

  it("refuses to start, and names both the fix and the escape", async () => {
    process.env.SIDECREW_PYTHON = stubPython;
    process.env.HF_HUB_CACHE = emptyCache;

    await expect(serve({ port, dir, quiet: true, force: true, readyTimeoutMs: 5_000 }))
      .rejects.toThrow(/refusing to start/);
    // The reason has to be the one that matters: not "this is untidy" but "your numbers stop comparing".
    await expect(serve({ port, dir, quiet: true, force: true, readyTimeoutMs: 5_000 }))
      .rejects.toThrow(/cannot be compared|non-negotiable #4/);
    await expect(serve({ port, dir, quiet: true, force: true, readyTimeoutMs: 5_000 }))
      .rejects.toThrow(/sidecrew models --pin/);
    await expect(serve({ port, dir, quiet: true, force: true, readyTimeoutMs: 5_000 }))
      .rejects.toThrow(/--allow-unpinned/);
  }, 30_000);

  it("refuses before it spawns anything, so nothing is left holding the port", async () => {
    process.env.SIDECREW_PYTHON = stubPython;
    process.env.HF_HUB_CACHE = emptyCache;
    await expect(serve({ port, dir, quiet: true, force: true, readyTimeoutMs: 5_000 })).rejects.toThrow();
    expect(await readPid(port, dir)).toBeNull();
    expect(await readRecord(port, dir)).toBeNull();
  }, 30_000);

  it("starts anyway with --allow-unpinned, and records that it is not reproducible", async () => {
    process.env.SIDECREW_PYTHON = stubPython;
    process.env.HF_HUB_CACHE = emptyCache;
    const record = await serve({ port, dir, quiet: true, force: true, allowUnpinned: true, readyTimeoutMs: 20_000 });
    // `Candidate.worker.revision` is taken from here, so the evidence travels with every candidate.
    expect(record.pinned).toBe(false);
    expect(await stop({ port, dir, quiet: true })).toBe(true);
  }, 40_000);
});
