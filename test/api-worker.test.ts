import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_HOST,
  API_MAX_RETRIES,
  apiKeyFrom,
  ApiKeyMissingError,
  assertApiTier,
  assertMeasuredUsage,
  completeApi,
  DEFAULT_API_BASE_URL,
  finishReasonOf,
  isRetryableStatus,
  resolveApiTier,
  retryAfterMs,
  API_BACKOFF_CAP_MS,
} from "../src/api-worker.js";
import { assertLocalTier } from "../src/worker.js";

// ── the guard ─────────────────────────────────────────────────────────────────────────────────────

describe("assertApiTier — an allowlist of one, and the mirror of assertLocalTier (ADR-0059)", () => {
  it("accepts the Anthropic host over https and nothing else", () => {
    expect(() => assertApiTier(DEFAULT_API_BASE_URL)).not.toThrow();
    expect(() => assertApiTier(`https://${ANTHROPIC_HOST}/`)).not.toThrow();
  });

  it("refuses a proxy, which is the hazard it exists for — a client's source would go to a third party", () => {
    for (const url of [
      "https://anthropic-proxy.example.com",
      "https://api.anthropic.com.evil.test",
      "https://gateway.internal",
      "https://localhost:8000",
    ]) {
      expect(() => assertApiTier(url)).toThrow(/talks to api\.anthropic\.com and nothing else/);
    }
  });

  it("refuses plain http, because the request carries a credential and the task's source", () => {
    expect(() => assertApiTier(`http://${ANTHROPIC_HOST}`)).toThrow(/https only/);
  });

  it("refuses something that is not a URL at all", () => {
    expect(() => assertApiTier("api.anthropic.com:443")).toThrow(/not a URL|https only/);
  });

  /**
   * The two guards are opposites and must stay that way. ADR-0059's whole reason for two functions is
   * that one client with a flag would be one edit from having neither, so the property is asserted
   * rather than left to the comments: no URL satisfies both.
   */
  it("is disjoint from assertLocalTier — no URL passes both guards", () => {
    for (const url of [DEFAULT_API_BASE_URL, "http://localhost:8000/v1", "https://example.test"]) {
      const okApi = ((): boolean => { try { assertApiTier(url); return true; } catch { return false; } })();
      const okLocal = ((): boolean => { try { assertLocalTier(url); return true; } catch { return false; } })();
      expect(okApi && okLocal).toBe(false);
    }
  });
});

// ── the credential ────────────────────────────────────────────────────────────────────────────────

describe("apiKeyFrom / resolveApiTier", () => {
  it("prefers sidecrew's own variable so a machine can give it a key of its own", () => {
    expect(apiKeyFrom({ SIDECREW_ANTHROPIC_API_KEY: "a", ANTHROPIC_API_KEY: "b" })).toBe("a");
    expect(apiKeyFrom({ ANTHROPIC_API_KEY: "b" })).toBe("b");
  });

  it("treats blank and absent alike — an empty variable is not a credential", () => {
    expect(apiKeyFrom({})).toBeNull();
    expect(apiKeyFrom({ ANTHROPIC_API_KEY: "   " })).toBeNull();
  });

  it("refuses rather than silently downgrading: the machine has no local fallback", () => {
    expect(() => resolveApiTier("claude-haiku-4-5", {})).toThrow(ApiKeyMissingError);
    // ADR-0032's shape: the fix is in the message.
    expect(() => resolveApiTier("claude-haiku-4-5", {})).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("carries the pinned model through rather than discovering one", () => {
    const ctx = resolveApiTier("claude-haiku-4-5", { ANTHROPIC_API_KEY: "k" });
    expect(ctx.model).toBe("claude-haiku-4-5");
    expect(ctx.baseUrl).toBe(DEFAULT_API_BASE_URL);
  });
});

// ── the retry rule, which is the one that can double a bill ───────────────────────────────────────

describe("the retry rule (ADR-0059)", () => {
  it("retries what the server refused before producing anything, and nothing else", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(529)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });

  it("honours retry-after in seconds, and caps what it will wait for", () => {
    expect(retryAfterMs("2", 0)).toBe(2_000);
    expect(retryAfterMs("999999", 0)).toBe(API_BACKOFF_CAP_MS);
    // No header: exponential from the attempt number.
    expect(retryAfterMs(null, 0)).toBeLessThan(retryAfterMs(null, 2));
    expect(retryAfterMs("not-a-number", 0)).toBeGreaterThan(0);
  });
});

/** A fetch that replies from a script, and records what it was asked. */
const scriptedFetch = (replies: { status: number; body?: unknown; headers?: Record<string, string> }[]) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (h: string) => r.headers?.[h.toLowerCase()] ?? null },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? ""),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
};

const okBody = (text = "hello", input = 11, output = 7) => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: input, output_tokens: output },
});

describe("completeApi", () => {
  const base = { apiKey: "k", model: "claude-haiku-4-5", messages: [{ role: "user" as const, content: "hi" }] };

  it("sends temperature 0 and no seed — determinism here is temperature and nothing more (ADR-0045 §5)", async () => {
    const { impl, calls } = scriptedFetch([{ status: 200, body: okBody() }]);
    await completeApi({ ...base, fetchImpl: impl });
    const sent = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(sent.temperature).toBe(0);
    expect(sent.seed).toBeUndefined();
    expect(sent.model).toBe("claude-haiku-4-5");
    expect(calls[0]!.url).toBe(`${DEFAULT_API_BASE_URL}/v1/messages`);
  });

  it("reads the API's own usage fields — the price is a measurement, never an estimate", async () => {
    const { impl } = scriptedFetch([{ status: 200, body: okBody("out", 100, 20) }]);
    const c = await completeApi({ ...base, fetchImpl: impl });
    expect(c.text).toBe("out");
    expect(c.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20 });
    expect(c.usage_estimated).toBe(false);
  });

  it("counts cache tokens into billed input, so enabling caching later cannot under-report", async () => {
    const body = {
      content: [{ type: "text", text: "x" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 5, cache_read_input_tokens: 3 },
    };
    const { impl } = scriptedFetch([{ status: 200, body }]);
    const c = await completeApi({ ...base, fetchImpl: impl });
    expect(c.usage.prompt_tokens).toBe(18);
  });

  it("labels a missing usage block rather than guessing (ADR-0019)", async () => {
    const { impl } = scriptedFetch([{ status: 200, body: { content: [{ type: "text", text: "x" }], stop_reason: "end_turn" } }]);
    const c = await completeApi({ ...base, fetchImpl: impl });
    expect(c.usage_estimated).toBe(true);
    expect(() => assertMeasuredUsage(c, 1)).toThrow(/measurements, not estimates/);
  });

  it("translates max_tokens into the truncation signal the pipeline already reads", async () => {
    expect(finishReasonOf("max_tokens")).toBe("length");
    expect(finishReasonOf("end_turn")).toBe("end_turn");
    expect(finishReasonOf(undefined)).toBeNull();
  });

  it("retries a 429 and succeeds", async () => {
    const { impl, calls } = scriptedFetch([
      { status: 429, body: { error: "slow down" }, headers: { "retry-after": "0" } },
      { status: 200, body: okBody() },
    ]);
    const c = await completeApi({ ...base, fetchImpl: impl, sleep: async () => {} });
    expect(c.text).toBe("hello");
    expect(calls.length).toBe(2);
  });

  it("gives up after a bounded number of retries rather than hammering the rate limit", async () => {
    const { impl, calls } = scriptedFetch([{ status: 429, body: { error: "no" } }]);
    await expect(completeApi({ ...base, fetchImpl: impl, sleep: async () => {} }))
      .rejects.toThrow(/HTTP 429.*after 2 retries/s);
    expect(calls.length).toBe(API_MAX_RETRIES + 1);
  });

  it("does not retry a 400 — the server's considered reply, and repeating it just says it twice", async () => {
    const { impl, calls } = scriptedFetch([{ status: 400, body: { error: "bad" } }]);
    await expect(completeApi({ ...base, fetchImpl: impl, sleep: async () => {} })).rejects.toThrow(/HTTP 400/);
    expect(calls.length).toBe(1);
  });

  it("names the environment variable when the credential is rejected (ADR-0032's shape)", async () => {
    const { impl } = scriptedFetch([{ status: 401, body: { error: "nope" } }]);
    await expect(completeApi({ ...base, fetchImpl: impl })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  /**
   * **The test that stands between this tier and a doubled bill.**
   *
   * A 429 was refused before anything was generated, so re-sending is free. A timeout is the case where
   * the completion may have been produced and billed while the answer never arrived — retrying it pays
   * twice, silently. If this ever inverts there is no error to notice, only a larger invoice.
   */
  it("does NOT retry a timeout or a dropped connection, because that request may already be billed", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;

    await expect(completeApi({ ...base, fetchImpl: impl, sleep: async () => {} })).rejects.toThrow(/aborted|timeout/i);
    expect(calls).toBe(1);
  });

  it("refuses to be pointed at a proxy even when a caller asks nicely", async () => {
    const { impl } = scriptedFetch([{ status: 200, body: okBody() }]);
    await expect(completeApi({ ...base, baseUrl: "https://proxy.example.com", fetchImpl: impl }))
      .rejects.toThrow(/nothing else/);
  });
});
