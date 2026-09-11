import { describe, it, expect, afterEach } from "vitest";
import { complete, assertLocalTier, decodeTokensPerSecond, DEFAULT_MAX_TOKENS, RETRY_BACKOFF_MS } from "../src/worker.js";
import { startFake, deadPort, type Fake } from "./fake-worker.js";

let fake: Fake | null = null;
afterEach(async () => { await fake?.close(); fake = null; });

const messages = [{ role: "user" as const, content: "hi" }];

describe("assertLocalTier", () => {
  it("refuses Anthropic, whatever the subdomain", () => {
    for (const url of ["https://api.anthropic.com/v1", "https://anthropic.com/v1", "https://EU.API.ANTHROPIC.COM/v1"]) {
      expect(() => assertLocalTier(url)).toThrow(/non-negotiable #1|refusing/i);
    }
  });

  it("allows localhost and anything that merely looks similar", () => {
    for (const url of ["http://localhost:8000/v1", "http://127.0.0.1:9/v1", "https://anthropic.com.example.org/v1", "https://notanthropic.com/v1"]) {
      expect(() => assertLocalTier(url)).not.toThrow();
    }
  });

  it("rejects a base URL that is not a URL at all", () => {
    // "localhost:8000" does parse — URL reads "localhost:" as the scheme — so hostname alone is not
    // enough to tell a base URL from a typo.
    expect(() => assertLocalTier("localhost:8000")).toThrow(/not a URL/);
    expect(() => assertLocalTier("")).toThrow(/not a URL/);
    expect(() => assertLocalTier("file:///etc/passwd")).toThrow(/not a URL/);
  });

  it("is checked before any request is made", async () => {
    // No server is running, so reaching the network would give a connection error instead.
    await expect(complete({ baseUrl: "https://api.anthropic.com/v1", model: "m", messages, seed: 1 }))
      .rejects.toThrow(/refusing/);
  });
});

describe("complete", () => {
  it("sends temperature 0, the seed, and the token budget", async () => {
    fake = await startFake();
    await complete({ baseUrl: fake.baseUrl, model: "m", messages, seed: 7, maxTokens: 128, stop: ["\n\n"] });

    const sent = fake.requests[0];
    expect(sent.temperature).toBe(0);
    expect(sent.seed).toBe(7);
    expect(sent.max_tokens).toBe(128);
    expect(sent.stop).toEqual(["\n\n"]);
    expect(sent.stream).toBe(true);
    // The seed is also what opts a request out of mlx_lm's batching (ADR-0003), so it is never optional.
    expect(sent).toHaveProperty("seed");
  });

  it("defaults the token budget rather than letting the server decide", async () => {
    fake = await startFake();
    await complete({ baseUrl: fake.baseUrl, model: "m", messages, seed: 1 });
    expect(fake.requests[0].max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("omits stop entirely when there is none, instead of sending an empty list", async () => {
    fake = await startFake();
    await complete({ baseUrl: fake.baseUrl, model: "m", messages, seed: 1, stop: [] });
    expect(fake.requests[0]).not.toHaveProperty("stop");
  });

  it("joins the streamed deltas into the whole text", async () => {
    fake = await startFake({ chunks: ["export ", "const ", "a = 1;"] });
    const r = await complete({ baseUrl: fake.baseUrl, model: "m", messages, seed: 1 });
    expect(r.text).toBe("export const a = 1;");
    expect(r.finish_reason).toBe("stop");
  });

  it("takes usage from the final chunk and marks it measured", async () => {
    fake = await startFake({ chunks: ["a", "b"] });
    const r = await complete({ baseUrl: fake.baseUrl, model: "m", messages, seed: 1 });
    expect(r.usage).toEqual({ prompt_tokens: 11, completion_tokens: 2 });
    expect(r.usage_estimated).toBe(false);
  });

  it("says so rather than inventing usage when the server sends none", async () => {
    fake = await startFake({ omitUsage: true });
    const r = await complete({ baseUrl: fake.baseUrl, model: "m", messages, seed: 1 });
    expect(r.usage_estimated).toBe(true);
    expect(r.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0 });
  });

  it("measures TTFT at the first token, not at the end of the stream", async () => {
    fake = await startFake({ chunks: ["a", "b", "c"], firstTokenDelayMs: 120, betweenChunksMs: 60 });
    const r = await complete({ baseUrl: fake.baseUrl, model: "m", messages, seed: 1 });
    expect(r.ttft_ms).toBeGreaterThanOrEqual(100);
    // Two more chunks at 60 ms each land well after the first.
    expect(r.wall_ms).toBeGreaterThan(r.ttft_ms + 50);
  });

  it("reassembles frames that arrive split across chunks", async () => {
    // Long content makes it likely at least one SSE frame straddles a TCP read.
    const chunks = Array.from({ length: 40 }, (_, i) => `${"x".repeat(500)}${i}`);
    fake = await startFake({ chunks });
    const r = await complete({ baseUrl: fake.baseUrl, model: "m", messages, seed: 1 });
    expect(r.text).toBe(chunks.join(""));
  });

  it("surfaces an HTTP error with the server's own explanation", async () => {
    fake = await startFake({ httpError: { status: 400, body: "model not found" } });
    await expect(complete({ baseUrl: fake.baseUrl, model: "m", messages, seed: 1 }))
      .rejects.toThrow(/HTTP 400.*model not found/);
  });

  it("does not retry an HTTP error — the server already answered", async () => {
    fake = await startFake({ httpError: { status: 500, body: "boom" } });
    await expect(complete({ baseUrl: fake.baseUrl, model: "m", messages, seed: 1 })).rejects.toThrow(/HTTP 500/);
    expect(fake.requests).toHaveLength(1);
  });

  it("retries once on a refused connection, then gives up with a way forward", async () => {
    const port = await deadPort();
    await expect(complete({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "m", messages, seed: 1 }))
      .rejects.toThrow(/ECONNREFUSED, twice.*sidecrew serve/s);
  });

  it("succeeds on the retry when the worker comes up in between", async () => {
    const port = await deadPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;

    // The first attempt is refused; the server binds that same port during the retry backoff, which is
    // the entire situation the backoff exists for.
    const pending = complete({ baseUrl, model: "m", messages, seed: 1 });
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS / 2));
    fake = await startFakeOn(port);

    const r = await pending;
    expect(r.text).toBe("Hello, world");
    expect(fake.requests).toHaveLength(1);
  });

  it("does not retry a connection that already carried tokens", async () => {
    // A second inference is not free, and at temperature 0 with a fixed seed it would only produce the
    // same bytes again — so a mid-stream reset is reported, not repeated. This must hold regardless of
    // which error code undici picks for a dropped stream, which is why the fact is recorded in the read
    // loop rather than inferred from the error afterwards.
    fake = await startFake({ chunks: ["a", "b", "c"], resetAfterChunks: 2 });
    await expect(complete({ baseUrl: fake.baseUrl, model: "m", messages, seed: 1 })).rejects.toThrow();
    expect(fake.requests).toHaveLength(1);
  });

  it("does not retry a stream dropped before its very first byte either, once one opened", async () => {
    // resetAfterChunks: 0 destroys the socket after the headers and before any data frame. The server
    // did answer, so this is not the "no worker listening" case a retry exists for.
    fake = await startFake({ chunks: ["a"], resetAfterChunks: 0 });
    await expect(complete({ baseUrl: fake.baseUrl, model: "m", messages, seed: 1 })).rejects.toThrow();
    expect(fake.requests).toHaveLength(1);
  });
});

describe("decodeTokensPerSecond", () => {
  const base = { text: "", usage: { prompt_tokens: 0, completion_tokens: 0 }, finish_reason: null, usage_estimated: false, ttft_ms: 0, wall_ms: 0 };

  it("counts the tokens after the first over the decode window, not over the whole request", () => {
    // 101 tokens, first at 1000 ms, last at 2000 ms → the 100 that followed took one second.
    expect(decodeTokensPerSecond({ ...base, usage: { prompt_tokens: 0, completion_tokens: 101 }, ttft_ms: 1000, wall_ms: 2000 })).toBeCloseTo(100, 6);
  });

  it("declines to divide by a window that is not there", () => {
    expect(decodeTokensPerSecond({ ...base, usage: { prompt_tokens: 0, completion_tokens: 1 }, ttft_ms: 10, wall_ms: 20 })).toBeNull();
    expect(decodeTokensPerSecond({ ...base, usage: { prompt_tokens: 0, completion_tokens: 50 }, ttft_ms: 20, wall_ms: 20 })).toBeNull();
  });
});

/** Same fake, on a port chosen by the caller — for the "worker appears between attempts" case. */
const startFakeOn = async (port: number): Promise<Fake> => {
  const { createServer } = await import("node:http");
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const content of ["Hello", ", ", "world"]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 3 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    server,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
};
