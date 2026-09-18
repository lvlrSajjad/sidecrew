// OpenAI-compatible client for the local MLX worker (mlx_lm.server).
//
// Invariants, each enforced here rather than documented and hoped for:
//   - the base URL is never Anthropic's (non-negotiable #1 — this is the local tier);
//   - temperature is 0 and a seed is always sent (non-negotiable #4);
//   - retry happens once, only for a connection that never carried a token.
//
// Sending `seed` does double duty. mlx_lm 0.31 decides batchability as
// `is_batchable and args.seed is None` (server.py `_is_batchable`), so a request that carries a seed
// is served alone, outside the batch — which is exactly the serialisation determinism needs. See
// ADR-0003.
export type Role = "system" | "user" | "assistant";
export interface Message { role: Role; content: string }

export interface CompleteOpts {
  /** e.g. http://localhost:8000/v1 */
  baseUrl: string;
  model: string;
  messages: Message[];
  seed: number;
  maxTokens?: number;
  stop?: string[];
  /** Wall clock for the whole request, first byte to last. */
  timeoutMs?: number;
}

export interface Usage { prompt_tokens: number; completion_tokens: number }

export interface Completion {
  text: string;
  usage: Usage;
  /** Request sent → last byte. */
  wall_ms: number;
  /** Request sent → first token of content. Equals wall_ms when nothing was generated. */
  ttft_ms: number;
  finish_reason: string | null;
  /** True when the server never sent a usage block and the token counts are not measurements. */
  usage_estimated: boolean;
}

export const DEFAULT_MAX_TOKENS = 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The one thing this client may never talk to.
 *
 * The zero-worker-tokens guarantee is only worth as much as the thing that enforces it, and the
 * cheapest way to break it by accident is an environment variable: `SIDECREW_BASE_URL` pointing at a
 * proxy, or a copy-pasted `ANTHROPIC_BASE_URL`. The api tier of ADR-0009 is a different code path with
 * its own accounting; it does not come through here.
 */
export const assertLocalTier = (baseUrl: string): void => {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`worker base URL is not a URL: ${baseUrl}`);
  }
  // `new URL("localhost:8000")` parses — "localhost:" is read as the scheme, leaving an empty host —
  // so a plain host:port would sail past a hostname check and fail much later, inside fetch. Demand a
  // scheme we can actually speak, and a host to speak it to.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`worker base URL is not a URL: ${baseUrl} (expected http:// or https://)`);
  }
  const host = url.hostname.toLowerCase();
  if (!host) throw new Error(`worker base URL is not a URL: ${baseUrl} (no host)`);

  if (host === "anthropic.com" || host.endsWith(".anthropic.com")) {
    throw new Error(
      `refusing to use ${baseUrl} as a worker: this is the local tier and must not spend Claude tokens (CLAUDE.md non-negotiable #1). The api tier of ADR-0009 is a separate path.`,
    );
  }
};

/** Node's fetch reports connection failures as a TypeError carrying the syscall error underneath. */
const connectionErrorCode = (e: unknown): string | null => {
  const cause = (e as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : null;
  return code === "ECONNREFUSED" || code === "ECONNRESET" ? code : null;
};

/**
 * Marks a failure that happened after the server had already begun answering.
 *
 * The rule "retry only a connection that never carried a token" cannot be expressed with error codes:
 * ECONNRESET is thrown both by a refused handshake and by a socket dropped halfway through a stream,
 * and which code undici picks for the second case is its business, not a contract. So the fact is
 * recorded where it is actually known — inside the read loop — rather than inferred afterwards.
 */
const STREAM_STARTED = Symbol("sidecrew.streamStarted");

const streamHadStarted = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as Record<symbol, unknown>)[STREAM_STARTED] === true;

const markStreamStarted = (e: unknown): unknown => {
  if (typeof e === "object" && e !== null) (e as Record<symbol, unknown>)[STREAM_STARTED] = true;
  return e;
};

const RETRYABLE_HINT = "start one with: sidecrew serve";

/**
 * How long to wait before the one retry.
 *
 * Not politeness — arithmetic. The situation a connection retry exists for is a worker that is
 * restarting, or one whose listener is a few milliseconds from binding. Retrying in the same tick asks
 * the same dead socket the same question and gets the same answer, which makes the retry a formality.
 */
export const RETRY_BACKOFF_MS = 250;

/**
 * One chat completion, streamed.
 *
 * Streaming is not for the tokens — we want the whole string — but for TTFT, which is the number that
 * separates "the model is slow" from "the model was still loading" and is the only one a non-streaming
 * call cannot give. `stream_options.include_usage` makes mlx_lm send the usage block on the final
 * chunk, so streaming costs us no accounting.
 */
export async function complete(opts: CompleteOpts): Promise<Completion> {
  assertLocalTier(opts.baseUrl);

  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    temperature: 0,
    seed: opts.seed,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(opts.stop?.length ? { stop: opts.stop } : {}),
    stream: true,
    stream_options: { include_usage: true },
  });

  try {
    return await attempt(opts, body);
  } catch (e) {
    const code = connectionErrorCode(e);
    // Only a connection that never opened is retried. A request that died mid-stream has already spent
    // an inference, and a second one would spend another for a byte-identical answer; a non-2xx is the
    // server's considered reply and repeating it just says it twice.
    if (!code || streamHadStarted(e)) throw e;
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    return attempt(opts, body).catch((again) => {
      if (connectionErrorCode(again)) {
        throw new Error(`no worker on ${opts.baseUrl} (${code}, twice) — ${RETRYABLE_HINT}`);
      }
      throw again;
    });
  }
}

interface Chunk {
  choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

async function attempt(opts: CompleteOpts, body: string): Promise<Completion> {
  const startedAt = performance.now();
  const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 512);
    throw new Error(`worker returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  if (!res.body) throw new Error("worker returned no body");

  const parts: string[] = [];
  let ttft_ms: number | null = null;
  let finish_reason: string | null = null;
  let usage: Usage | null = null;

  // SSE arrives in arbitrary chunks, so a frame can straddle two reads; `buffer` holds the tail until
  // the blank line that ends the frame shows up.
  let buffer = "";
  const decoder = new TextDecoder();

  const consume = (frame: string): void => {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;

      let chunk: Chunk;
      try {
        chunk = JSON.parse(payload) as Chunk;
      } catch {
        continue; // A frame we cannot read is not a reason to lose the ones we can.
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        ttft_ms ??= performance.now() - startedAt;
        parts.push(delta);
      }
      if (typeof choice?.finish_reason === "string") finish_reason = choice.finish_reason;
      if (chunk.usage) {
        usage = { prompt_tokens: num(chunk.usage.prompt_tokens), completion_tokens: num(chunk.usage.completion_tokens) };
      }
    }
  };

  let started = false;
  try {
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      started = true;
      buffer += decoder.decode(bytes, { stream: true });
      let cut = buffer.indexOf("\n\n");
      while (cut !== -1) {
        consume(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf("\n\n");
      }
    }
  } catch (e) {
    throw started ? markStreamStarted(e) : e;
  }
  if (buffer.trim()) consume(buffer); // A final frame with no trailing blank line.

  const wall_ms = performance.now() - startedAt;
  const text = parts.join("");

  return {
    text,
    // A server that sends no usage block leaves us with no token counts. Reporting a guess as a
    // measurement would put a fiction into Candidate.usage and from there into the go/no-go numbers,
    // so the estimate is labelled and the caller decides whether it may use it.
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0 },
    usage_estimated: usage === null,
    wall_ms,
    ttft_ms: ttft_ms ?? wall_ms,
    finish_reason,
  };
}

/**
 * completion_tokens per second of decoding — the generation rate, with prefill excluded.
 *
 * Structural rather than over `Completion`, so `runBatch`'s thermal guard can compute it from a
 * `Candidate` (ADR-0025). One formula, one place: a back-off that compared a differently-derived rate
 * against `bench`'s `decode_tok_s` would be comparing two numbers, not one number twice.
 */
export const decodeTokensPerSecond = (c: { usage: Usage; wall_ms: number; ttft_ms: number }): number | null => {
  const decodeMs = c.wall_ms - c.ttft_ms;
  if (c.usage.completion_tokens <= 1 || decodeMs <= 0) return null;
  // The first token arrived at ttft; the remaining n-1 are what the decode window actually produced.
  return ((c.usage.completion_tokens - 1) / decodeMs) * 1000;
};
