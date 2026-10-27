import { inspect } from "node:util";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Secret } from "../../config/secret";
import { startFakeProvider, type FakeProvider } from "../../../../../tests/support/fake-provider";
import { createProvider } from "./index";
import { ProviderError } from "./shared";
import type { ProviderAdapter, ProviderEvent, ProviderMessage } from "./types";

const KEY = "sk-test-KEYVALUE-0123456789";
const MESSAGES: ProviderMessage[] = [
  { role: "system", content: "Be brief." },
  { role: "user", content: "Hello?" },
];
const noWait = { sleep: async () => undefined, random: () => 0 };

let fake: FakeProvider;
beforeAll(async () => {
  fake = await startFakeProvider();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => fake.reset());

type Make = (deps?: { fetch?: typeof fetch }) => ProviderAdapter;
const adapters: [string, Make][] = [
  [
    "anthropic",
    (deps) =>
      createProvider({ provider: "anthropic", apiKey: new Secret(KEY) }, "model-x", {
        anthropicEndpoint: fake.anthropicEndpoint,
        ...noWait,
        ...deps,
      }),
  ],
  [
    "openai-compatible",
    (deps) =>
      createProvider(
        {
          provider: "openai-compatible",
          baseUrl: new URL(fake.openAiBaseUrl),
          apiKey: new Secret(KEY),
        },
        "model-x",
        { ...noWait, ...deps },
      ),
  ],
];

async function drain(iterable: AsyncIterable<ProviderEvent>) {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return {
    events,
    text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
  };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error("expected a ProviderError");
}

describe.each(adapters)("%s adapter", (_name, make) => {
  const options = { maxTokens: 100 };

  it("streams text chunks in order, then the provider's usage", async () => {
    fake.enqueue({
      kind: "text",
      chunks: ["Hel", "lo ", "there"],
      usage: { input: 30, output: 5 },
    });
    const { events, text } = await drain(make().stream(MESSAGES, options));
    expect(text).toBe("Hello there");
    expect(events.at(-1)).toEqual({ type: "usage", inputTokens: 30, outputTokens: 5 });
  });

  it("completes once with text and usage", async () => {
    fake.enqueue({ kind: "text", chunks: ['{"a":1}'], usage: { input: 3, output: 4 } });
    expect(await make().completeOnce(MESSAGES, options)).toEqual({
      text: '{"a":1}',
      inputTokens: 3,
      outputTokens: 4,
      cutOff: false,
    });
    expect(fake.requests[0]?.stream).toBe(false);
  });

  it("sends the model and token cap as body fields, and the key only as a credential header", async () => {
    await drain(make().stream(MESSAGES, { maxTokens: 321 }));
    const request = fake.requests[0]!;
    expect(request.body).toMatchObject({ model: "model-x", stream: true });
    expect(request.body.max_tokens).toBe(321);
    expect(JSON.stringify(request.body)).not.toContain(KEY);
    expect(request.path).not.toContain("model-x");
    if (request.protocol === "anthropic") {
      expect(request.headers["x-api-key"]).toBe(KEY);
      expect(request.body.system).toBe("Be brief.");
      expect(request.body.messages).toEqual([{ role: "user", content: "Hello?" }]);
    } else {
      expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(request.body.messages).toEqual(MESSAGES);
    }
  });

  it("maps HTTP failures to fixed kinds", async () => {
    const cases: [number, string][] = [
      [401, "rejected"],
      [403, "rejected"],
      [404, "not_found"],
      [400, "unavailable"],
      [429, "rate_limited"],
      [500, "unavailable"],
      [503, "unavailable"],
    ];
    for (const [status, kind] of cases) {
      fake.reset();
      fake.setDefault({ kind: "status", status });
      expect((await failure(drain(make().stream(MESSAGES, options)))).kind).toBe(kind);
      expect((await failure(make().completeOnce(MESSAGES, options))).kind).toBe(kind);
    }
  });

  it("retries once on 429 and on 5xx before any output, and not on other errors", async () => {
    fake.enqueue({ kind: "status", status: 503 }, { kind: "text", chunks: ["fine"] });
    expect((await drain(make().stream(MESSAGES, options))).text).toBe("fine");
    expect(fake.requests).toHaveLength(2);

    fake.reset();
    fake.enqueue({ kind: "status", status: 429 }, { kind: "text", chunks: ["fine"] });
    expect((await make().completeOnce(MESSAGES, options)).text).toBe("fine");
    expect(fake.requests).toHaveLength(2);

    fake.reset();
    fake.setDefault({ kind: "status", status: 500 });
    await failure(drain(make().stream(MESSAGES, options)));
    expect(fake.requests).toHaveLength(2); // one retry, then give up

    fake.reset();
    fake.setDefault({ kind: "status", status: 401 });
    await failure(drain(make().stream(MESSAGES, options)));
    expect(fake.requests).toHaveLength(1);
  });

  it("never retries once output has started", async () => {
    fake.setDefault({ kind: "error_after_output", chunks: ["partial"] });
    const seen: string[] = [];
    const error = await failure(
      (async () => {
        for await (const event of make().stream(MESSAGES, options)) {
          if (event.type === "text") seen.push(event.text);
        }
      })(),
    );
    expect(seen.join("")).toBe("partial");
    expect(error.kind).toBe("unavailable");
    expect(fake.requests).toHaveLength(1);
  });

  it("keeps the key and the provider's error text out of errors and their inspection", async () => {
    fake.setDefault({ kind: "status", status: 401 });
    const error = await failure(drain(make().stream(MESSAGES, options)));
    for (const shown of [error.message, String(error), inspect(error), JSON.stringify(error)]) {
      expect(shown).not.toContain(KEY);
      expect(shown).not.toContain("SECRET-PROVIDER-TEXT");
    }
    expect(error.message).toBe("provider error: rejected");
    expect(error.cause).toBeUndefined();
  });

  it("reports a network failure as unavailable, without the underlying message", async () => {
    const broken = make({
      fetch: async () => {
        throw new TypeError(`connect ECONNREFUSED with ${KEY}`);
      },
    });
    const error = await failure(drain(broken.stream(MESSAGES, options)));
    expect(error.kind).toBe("unavailable");
    expect(inspect(error)).not.toContain(KEY);
  });

  it("refuses redirects instead of following them with the key", async () => {
    let init: RequestInit | undefined;
    const spy = make({
      fetch: async (_url, i) => {
        init = i;
        throw new TypeError("redirect");
      },
    });
    await failure(drain(spy.stream(MESSAGES, options)));
    expect(init?.redirect).toBe("error");
  });

  it("maps a malformed event and a truncated stream to malformed", async () => {
    fake.setDefault({ kind: "malformed", chunks: ["a"] });
    expect((await failure(drain(make().stream(MESSAGES, options)))).kind).toBe("malformed");
    fake.reset();
    fake.setDefault({ kind: "truncated", chunks: ["a"] });
    expect((await failure(drain(make().stream(MESSAGES, options)))).kind).toBe("malformed");
    fake.reset();
    fake.setDefault({ kind: "malformed" });
    expect((await failure(make().completeOnce(MESSAGES, options))).kind).toBe("malformed");
  });

  it("hits the deadline on a stalled stream, keeping the text received", async () => {
    fake.setDefault({ kind: "stall", chunks: ["so far"] });
    const seen: string[] = [];
    const started = Date.now();
    const error = await failure(
      (async () => {
        for await (const event of make().stream(MESSAGES, { maxTokens: 100, deadlineMs: 150 })) {
          if (event.type === "text") seen.push(event.text);
        }
      })(),
    );
    expect(error.kind).toBe("timeout");
    expect(seen.join("")).toBe("so far");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("stops the upstream request when the caller aborts", async () => {
    fake.setDefault({
      kind: "slow",
      chunks: Array.from({ length: 50 }, () => "word "),
      delayMs: 20,
    });
    const controller = new AbortController();
    const error = await failure(
      (async () => {
        for await (const event of make().stream(MESSAGES, {
          maxTokens: 100,
          signal: controller.signal,
        })) {
          if (event.type === "text") controller.abort();
        }
      })(),
    );
    expect(error.kind).toBe("aborted");
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.requests[0]?.aborted).toBe(true);
  });

  it("does not start a request when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await failure(
      drain(make().stream(MESSAGES, { maxTokens: 100, signal: controller.signal })),
    );
    expect(error.kind).toBe("aborted");
  });

  it("cuts an oversized stream at the character limit and closes the upstream request", async () => {
    fake.setDefault({ kind: "oversize", chars: 5_000_000 });
    const { events, text } = await drain(
      make().stream(MESSAGES, { maxTokens: 100, maxChars: 1000 }),
    );
    expect(text).toHaveLength(1000);
    expect(events.at(-1)).toEqual({ type: "cut_off" });
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.requests[0]?.aborted).toBe(true);
  });

  it("reports a provider stop for length as cut_off, and a content filter as filtered", async () => {
    fake.setDefault({ kind: "cut_off", chunks: ["abc"] });
    const cut = await drain(make().stream(MESSAGES, options));
    expect(cut.text).toBe("abc");
    expect(cut.events.at(-1)).toEqual({ type: "cut_off" });
    expect((await make().completeOnce(MESSAGES, options)).cutOff).toBe(true);

    fake.setDefault({ kind: "filtered", chunks: ["a"] });
    expect((await failure(drain(make().stream(MESSAGES, options)))).kind).toBe("filtered");
    expect((await failure(make().completeOnce(MESSAGES, options))).kind).toBe("filtered");
  });
});

describe("openai-compatible adapter specifics", () => {
  it("sends no authorization header without a key (local server)", async () => {
    const local = createProvider(
      { provider: "openai-compatible", baseUrl: new URL(fake.openAiBaseUrl), apiKey: null },
      "llama3.1:8b",
      noWait,
    );
    await drain(local.stream(MESSAGES, { maxTokens: 10 }));
    expect(fake.requests[0]?.headers.authorization).toBeUndefined();
    expect(fake.requests[0]?.body.model).toBe("llama3.1:8b");
  });

  it("keeps the base path, with or without a trailing slash, and ignores a query string", async () => {
    for (const base of [`${fake.origin}/v1`, `${fake.origin}/v1/`, `${fake.origin}/v1?x=1#y`]) {
      fake.reset();
      const adapter = createProvider(
        { provider: "openai-compatible", baseUrl: new URL(base), apiKey: null },
        "m",
        noWait,
      );
      await drain(adapter.stream(MESSAGES, { maxTokens: 10 }));
      expect(fake.requests[0]?.path).toBe("/v1/chat/completions");
    }
  });
});
