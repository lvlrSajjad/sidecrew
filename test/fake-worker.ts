// A tiny OpenAI-compatible server, so the worker client can be tested without a model.
//
// It is deliberately literal about the wire format mlx_lm actually produces — SSE frames separated by
// a blank line, content in `choices[0].delta.content`, usage only on the final chunk and only when
// `stream_options.include_usage` was sent. A fake that is nicer than the real server would let a bug
// through in exactly the place this client is hard to get right.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOpts {
  /** Emitted one SSE frame at a time, in order. */
  chunks?: string[];
  /**
   * A different answer per request, chosen from the request body.
   *
   * Workload #2a's loop is several tasks over ordered steps, and a fake that says the same thing every
   * time cannot exercise it: the step boundary only means something if step 2's task sees what step 1
   * left behind. Takes precedence over `chunks`.
   */
  chunksFor?: (body: Record<string, unknown>) => string[];
  /** Delay before the first content chunk, to make TTFT measurable. */
  firstTokenDelayMs?: number;
  /** Delay between chunks after the first. */
  betweenChunksMs?: number;
  /** Omit the usage frame, the way a server without stream_options support would. */
  omitUsage?: boolean;
  /**
   * Send a usage frame of zeros while streaming real content — what the Apple shim does (ADR-0019).
   *
   * Worse than `omitUsage`, because it answers the question a client is likely to ask ("is there a
   * usage block?") with a lie rather than with nothing.
   */
  zeroUsage?: boolean;
  /** Answer every completion with this status and body instead. */
  httpError?: { status: number; body: string };
  /** Destroy the socket mid-response after this many chunks — an ECONNRESET with tokens already sent. */
  resetAfterChunks?: number;
  finishReason?: string;
  modelId?: string;
  /** Several ids from `/v1/models`, the way mlx_lm lists everything in the Hugging Face cache. */
  modelIds?: string[];
}

export interface Fake {
  baseUrl: string;
  port: number;
  /** Every completion request body this server received, parsed. */
  requests: Record<string, unknown>[];
  close: () => Promise<void>;
  server: Server;
}

const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;

export const startFake = async (opts: FakeOpts = {}): Promise<Fake> => {
  const chunks = opts.chunks ?? ["Hello", ", ", "world"];
  const modelId = opts.modelId ?? "fake-model";
  const catalogue = opts.modelIds ?? [modelId];
  const requests: Record<string, unknown>[] = [];

  const server = createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: catalogue.map((id) => ({ id, object: "model" })) }));
      return;
    }

    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", async () => {
      try {
        requests.push(JSON.parse(body) as Record<string, unknown>);
      } catch {
        requests.push({ unparseable: body });
      }

      if (opts.httpError) {
        res.writeHead(opts.httpError.status, { "content-type": "text/plain" });
        res.end(opts.httpError.body);
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const chunks = opts.chunksFor ? opts.chunksFor(requests.at(-1) ?? {}) : (opts.chunks ?? ["Hello", ", ", "world"]);

      if (opts.firstTokenDelayMs) await wait(opts.firstTokenDelayMs);

      for (const [i, content] of chunks.entries()) {
        if (i > 0 && opts.betweenChunksMs) await wait(opts.betweenChunksMs);
        res.write(sse({ id: "1", object: "chat.completion.chunk", model: modelId, choices: [{ index: 0, delta: { content }, finish_reason: null }] }));
        if (opts.resetAfterChunks !== undefined && i + 1 >= opts.resetAfterChunks) {
          res.socket?.destroy();
          return;
        }
      }

      res.write(sse({ id: "1", object: "chat.completion.chunk", model: modelId, choices: [{ index: 0, delta: {}, finish_reason: opts.finishReason ?? "stop" }] }));
      if (!opts.omitUsage) {
        const usage = opts.zeroUsage
          ? { prompt_tokens: 0, completion_tokens: 0 }
          : { prompt_tokens: 11, completion_tokens: chunks.length };
        res.write(sse({ id: "1", object: "chat.completion.chunk", model: modelId, choices: [], usage }));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    server,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
};

/** A port nothing is listening on, for the connection-refused path. */
export const deadPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};
