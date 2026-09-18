// The `api` tier's worker client: Claude over the Anthropic Messages API, for machines that cannot
// host a local model (ADR-0009, ADR-0045, ADR-0059).
//
// This is the sibling of `src/worker.ts` and deliberately not an extension of it. The two clients
// enforce *opposite* invariants, and a single client with a flag would be one edit away from having
// neither:
//
//   - `worker.ts` may talk to anything except Anthropic  — `assertLocalTier`
//   - `api-worker.ts` may talk to Anthropic and nothing else — `assertApiTier`
//
// What is shared is the `Completion` shape, so that `generate` and `generateChange` can refuse an
// estimated usage block on either tier with the same code (ADR-0019).
import { type Completion, type Message } from "./worker.js";

/** The only host this client may reach. ADR-0059: the api guard's job is to refuse everything else. */
export const ANTHROPIC_HOST = "api.anthropic.com";
export const DEFAULT_API_BASE_URL = `https://${ANTHROPIC_HOST}`;

/** The Messages API version header. A dated constant, like a pinned revision — not "whatever is new". */
export const ANTHROPIC_VERSION = "2023-06-01";

export const DEFAULT_API_MAX_TOKENS = 4096;
export const DEFAULT_API_TIMEOUT_MS = 300_000;

/**
 * The mirror of `assertLocalTier`, and the reason it is a second function rather than a parameter.
 *
 * `assertLocalTier` exists because the cheapest way to break the zero-worker-tokens guarantee by
 * accident is an environment variable pointing somewhere it should not. The same hazard runs the other
 * way here and costs money rather than a claim: a `SIDECREW_API_BASE_URL` aimed at a logging proxy, a
 * corporate gateway or somebody's laptop would send the task's source — which on a real run is a
 * client's code (CLAUDE.md #7) — to a third party, and the run would look entirely normal.
 *
 * So this is an **allowlist of one**, not a denylist, and https is not optional: the alternative is a
 * credential and a source file crossing a network in the clear.
 */
export const assertApiTier = (baseUrl: string): void => {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`api worker base URL is not a URL: ${baseUrl}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `refusing to use ${baseUrl} as an api-tier worker: this tier sends the task's source over the ` +
      "network and carries a credential, so it speaks https only.",
    );
  }
  if (url.hostname.toLowerCase() !== ANTHROPIC_HOST) {
    throw new Error(
      `refusing to use ${baseUrl} as an api-tier worker: the api tier talks to ${ANTHROPIC_HOST} and ` +
      "nothing else (ADR-0059). A proxy here would send the task's files to a third party and the run " +
      "would look normal. The local tier is a separate path.",
    );
  }
};

/**
 * Where the credential comes from, and what to say when it is absent.
 *
 * `SIDECREW_ANTHROPIC_API_KEY` first so that a machine can give sidecrew its own key without changing
 * what every other tool on the machine reads.
 */
export const apiKeyFrom = (env: NodeJS.ProcessEnv = process.env): string | null =>
  env.SIDECREW_ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim() || null;

export const MISSING_KEY_HINT =
  "this machine is the api tier (not enough installed RAM to host a local worker), so the worker is " +
  "Claude over the Anthropic API and it needs a key. Set ANTHROPIC_API_KEY (or " +
  "SIDECREW_ANTHROPIC_API_KEY) in the environment sidecrew runs in.";

export class ApiKeyMissingError extends Error {
  public constructor() {
    super(`no Anthropic API key — ${MISSING_KEY_HINT}`);
    this.name = "ApiKeyMissingError";
  }
}

/**
 * Everything the api tier needs to make a call, resolved once per run.
 *
 * `model` is the pinned id from `models.json` (ADR-0060) rather than anything discovered: a hosted
 * endpoint will happily answer to a name nobody chose, which is the same hazard `discoverWorkers`
 * refuses locally (ADR-0029), minus the reload that makes it visible.
 */
export interface ApiTierContext {
  model: string;
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * The api tier, resolved or refused — never silently downgraded.
 *
 * A machine on this tier has no local fallback (that is what put it here), so a missing key is a hard
 * stop with the fix in it, in ADR-0032's shape: the cause, whose it is, and the exact remedy.
 */
export const resolveApiTier = (
  model: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): ApiTierContext => {
  const apiKey = apiKeyFrom(env);
  if (apiKey === null) throw new ApiKeyMissingError();
  return { model, apiKey, baseUrl: env.SIDECREW_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL, fetchImpl };
};

/**
 * The two refusals `generate` and `generateChange` already make locally (ADR-0019), stated once for
 * this tier — where they matter more, because an estimate here is a made-up **price** and Phase 13
 * §5.0.2 voids a run whose worker tokens are not what Anthropic billed.
 */
export const assertMeasuredUsage = (c: Completion, textLength: number): void => {
  if (c.usage_estimated) {
    throw new Error(
      "the Anthropic API returned no usage block, so this candidate's token counts would be a guess. " +
      "sidecrew records measurements, not estimates — and on the api tier the token count is the price.",
    );
  }
  if (textLength > 0 && c.usage.completion_tokens === 0) {
    throw new Error(
      `the Anthropic API reported 0 completion tokens for ${textLength} characters of output, ` +
      "so this candidate's token counts are a fiction rather than a measurement.",
    );
  }
};

export interface ApiCompleteOpts {
  /** Defaults to https://api.anthropic.com. Only ever that host — see `assertApiTier`. */
  baseUrl?: string;
  apiKey: string;
  /** The pinned model id from models.json's api tier (ADR-0060). */
  model: string;
  messages: Message[];
  maxTokens?: number;
  stop?: string[];
  timeoutMs?: number;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so the back-off does not make the suite sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How many times a *refused* request is re-sent, and how long the wait grows.
 *
 * Two, not more: a rate limit that survives three attempts is a fact about the account rather than a
 * blip, and a tier that hammers it is a worse failure than a task that escalates (ADR-0059).
 */
export const API_MAX_RETRIES = 2;
export const API_BACKOFF_MS = 1_000;
/** A server may ask for a very long wait; we cap it rather than hang a run on somebody's header. */
export const API_BACKOFF_CAP_MS = 30_000;

/**
 * **The rule that decides whether this tier can double-bill.**
 *
 * `worker.ts` retries only a connection that never carried a token, because a request that died
 * mid-stream has already spent an inference. The same sentence with money in it (ADR-0059):
 *
 *   - **429 and 5xx are retried.** The server refused the request before producing anything, so
 *     nothing was generated and nothing was billed. Re-sending is free of that hazard.
 *   - **A timeout or a dropped connection is not retried.** Those are exactly the cases where the
 *     completion may have been produced and billed while the answer never reached us, and a retry
 *     would pay for it twice. Escalating a task costs a task; double-billing costs money and is
 *     invisible.
 *
 * An SDK that retries connection errors by default does the one thing this tier most needs not to do,
 * which is why this is written here rather than inherited.
 */
export const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

/** `retry-after` is seconds or an HTTP date; we read the seconds form and ignore the rest. */
export const retryAfterMs = (header: string | null, attempt: number): number => {
  const seconds = header === null ? NaN : Number(header.trim());
  const asked = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : API_BACKOFF_MS * 2 ** attempt;
  return Math.min(asked, API_BACKOFF_CAP_MS);
};

interface MessagesResponse {
  content?: { type?: unknown; text?: unknown }[];
  stop_reason?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
  };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * The Messages API's `stop_reason` in the local client's vocabulary.
 *
 * `generateChange` reads `finish_reason === "length"` to set `ChangeCandidate.truncated`, and that
 * field is one of the two rows in `FixResult.stats` that say a number is about the **edit format**
 * rather than about the model (ADR-0047 §2). Translating here keeps one concept in the pipeline
 * instead of teaching every caller two spellings of it.
 */
export const finishReasonOf = (stopReason: unknown): string | null => {
  if (typeof stopReason !== "string") return null;
  return stopReason === "max_tokens" ? "length" : stopReason;
};

const sleepFor = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One Messages API call, non-streaming.
 *
 * Non-streaming because this tier needs the whole string and nothing else: ADR-0045 §5 gives it one
 * turn, no tools and no conversation, and streaming exists in the local client for TTFT, which this
 * tier does not claim (ADR-0059). `ttft_ms` is therefore reported equal to `wall_ms`; §5 reports wall
 * clock and makes no criterion of it.
 *
 * Determinism here is `temperature: 0` and nothing more. There is no seed on this tier and the
 * candidate records `seed: null` rather than a value we never sent — Phase 1's 5/5 byte-identical
 * check is a local-tier test (ADR-0045 §5).
 */
export async function completeApi(opts: ApiCompleteOpts): Promise<Completion> {
  const baseUrl = opts.baseUrl ?? DEFAULT_API_BASE_URL;
  assertApiTier(baseUrl);

  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? sleepFor;
  const body = JSON.stringify({
    model: opts.model,
    max_tokens: opts.maxTokens ?? DEFAULT_API_MAX_TOKENS,
    temperature: 0,
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
    ...(opts.stop?.length ? { stop_sequences: opts.stop } : {}),
  });

  const startedAt = performance.now();
  let lastRefusal = "";

  for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt += 1) {
    const res = await doFetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS),
    });
    // A thrown fetch — timeout, reset, DNS — propagates out of this loop on purpose. See
    // `isRetryableStatus`: that is the case where the completion may already have been billed.

    if (res.ok) return read(await res.json() as MessagesResponse, startedAt);

    const detail = (await res.text().catch(() => "")).slice(0, 512);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Anthropic rejected the credential (HTTP ${res.status}) — ${MISSING_KEY_HINT}`);
    }
    if (!isRetryableStatus(res.status) || attempt === API_MAX_RETRIES) {
      throw new Error(
        `api worker returned HTTP ${res.status}${detail ? `: ${detail}` : ""}` +
        (isRetryableStatus(res.status) ? ` (after ${API_MAX_RETRIES} retries)` : ""),
      );
    }
    lastRefusal = `HTTP ${res.status}`;
    await sleep(retryAfterMs(res.headers.get("retry-after"), attempt));
  }

  // Unreachable: the loop either returns or throws on its final attempt. Kept so a future edit to the
  // bounds cannot fall out of the function with no answer and no error.
  throw new Error(`api worker made no request that returned (${lastRefusal})`);
}

const read = (payload: MessagesResponse, startedAt: number): Completion => {
  const text = (payload.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");

  const u = payload.usage;
  // The Messages API always sends usage. When it does not, the counts would be a guess, and both
  // `generate` and `generateChange` refuse a candidate whose usage is estimated (ADR-0019) — which on
  // this tier is the difference between a measured price and a made-up one (Phase 13 §5.0.2).
  const usage_estimated = u === undefined || u.input_tokens === undefined || u.output_tokens === undefined;
  const wall_ms = performance.now() - startedAt;

  return {
    text,
    // Billed input is the plain input plus anything the cache wrote or served. We do not use caching,
    // so these are zero — they are summed anyway so that turning it on later cannot silently
    // under-report what Anthropic charged.
    usage: {
      prompt_tokens: num(u?.input_tokens) + num(u?.cache_creation_input_tokens) + num(u?.cache_read_input_tokens),
      completion_tokens: num(u?.output_tokens),
    },
    usage_estimated,
    wall_ms,
    // This tier does not stream, so there is no first-token time to report. Equal to wall_ms, and
    // ADR-0059 says so rather than leaving a reader to infer that the model answered instantly.
    ttft_ms: wall_ms,
    finish_reason: finishReasonOf(payload.stop_reason),
  };
};
