import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_WEBHOOK_BODY_BYTES,
  acknowledgeOnly,
  handleWebhookRequest,
  methodNotAllowed,
  type WebhookDeps,
  type WebhookDispatch,
} from "./endpoint";

const SECRET = "SENTINEL-webhook-secret-3b8e5a";
const DELIVERY = "72d3162e-cc78-11e3-81ab-4c9367dc0958";
const PUSH = { ref: "refs/heads/main", repository: { id: 101, full_name: "acme/handbook" } };

function sign(body: Uint8Array | string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function bytes(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

interface Options {
  body?: Uint8Array | string;
  event?: string | null;
  delivery?: string | null;
  signature?: string | null;
  contentType?: string | null;
  headers?: Record<string, string>;
}

/** A GitHub-like delivery, signed with SECRET over the exact body unless told otherwise. */
function delivery(options: Options = {}): Request {
  const body = options.body ?? JSON.stringify(PUSH);
  // A copy over a plain ArrayBuffer, so it is a valid `BodyInit`.
  const raw = new Uint8Array(typeof body === "string" ? bytes(body) : body);
  const headers = new Headers(options.headers);
  const set = (name: string, value: string | null | undefined, fallback: string) => {
    const v = value === undefined ? fallback : value;
    if (v !== null) headers.set(name, v);
  };
  set("content-type", options.contentType, "application/json");
  set("x-github-event", options.event, "push");
  set("x-github-delivery", options.delivery, DELIVERY);
  set("x-hub-signature-256", options.signature, sign(raw));
  headers.set("user-agent", "GitHub-Hookshot/abc123");
  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    headers,
    body: raw,
  });
}

function setup(overrides: Partial<WebhookDeps> = {}) {
  const readSecret = vi.fn((): string | null => SECRET);
  const dispatch = vi.fn<WebhookDispatch>(async () => undefined);
  const log = vi.fn<(message: string, ...details: string[]) => void>();
  const deps: WebhookDeps = { readSecret, dispatch, log, ...overrides };
  return {
    readSecret,
    dispatch,
    log,
    handle: (request: Request) => handleWebhookRequest(request, deps),
  };
}

async function expectUnauthorized(response: Response) {
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthorized" });
}

/** Everything a response or the log exposes, as one string. */
async function exposed(response: Response, log: ReturnType<typeof setup>["log"]) {
  const headers = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  return `${response.status}\n${headers}\n${await response.text()}\n${JSON.stringify(log.mock.calls)}`;
}

describe("handleWebhookRequest: valid deliveries", () => {
  it("accepts a correctly signed push with 202 and dispatches it once", async () => {
    const { handle, dispatch, readSecret } = setup();
    const response = await handle(delivery());
    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
    expect(readSecret).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("push", PUSH, DELIVERY);
  });

  it("passes a null delivery id when X-GitHub-Delivery is absent", async () => {
    const { handle, dispatch } = setup();
    expect((await handle(delivery({ delivery: null }))).status).toBe(202);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("push", PUSH, null);
  });

  it("accepts a content type with parameters", async () => {
    const { handle, dispatch } = setup();
    const response = await handle(delivery({ contentType: "Application/JSON; charset=utf-8" }));
    expect(response.status).toBe(202);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("answers ping with 200 and does not dispatch it", async () => {
    const { handle, dispatch } = setup();
    const body = JSON.stringify({ zen: "Design for failure.", hook_id: 1, hook: {} });
    const response = await handle(delivery({ event: "ping", body }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, event: "ping" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("uses the default dispatcher when none is given", async () => {
    const { handle } = setup({ dispatch: undefined });
    expect((await handle(delivery())).status).toBe(202);
    await expect(acknowledgeOnly("push", PUSH, null)).resolves.toBeUndefined();
  });

  it("verifies the raw bytes: BOM, unicode and escaped control characters", async () => {
    const { handle, dispatch } = setup();
    const text = '{"msg":"café \u{1f680} \\u0000 \\ud83d\\ude80","n":1}';
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(text)]);
    expect((await handle(delivery({ body }))).status).toBe(202);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      "push",
      { msg: "café \u{1f680} \u0000 \u{1f680}", n: 1 },
      DELIVERY,
    );
  });

  it("verifies before decoding: a signed body with invalid UTF-8 is a 400, not a 401", async () => {
    const { handle, dispatch } = setup();
    const body = Buffer.concat([bytes('{"a":"'), Buffer.from([0xff, 0xfe]), bytes('"}')]);
    const response = await handle(delivery({ body }));
    expect(response.status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not throw when the dispatcher returns a non-promise", async () => {
    const dispatch = vi.fn(() => undefined) as unknown as WebhookDispatch;
    const { handle } = setup({ dispatch });
    expect((await handle(delivery())).status).toBe(202);
  });
});

describe("handleWebhookRequest: rejected signatures", () => {
  const body = JSON.stringify(PUSH);
  const hex = sign(body).slice("sha256=".length);
  const sha1 = `sha1=${createHmac("sha1", SECRET).update(body).digest("hex")}`;

  it.each<[string, Options]>([
    ["a missing signature", { signature: null }],
    ["an empty signature", { signature: "" }],
    ["the legacy sha1 header only", { signature: null, headers: { "x-hub-signature": sha1 } }],
    ["a sha1 value in the sha256 header", { signature: sha1 }],
    ["a wrong secret", { signature: sign(body, "another-secret-0123456789") }],
    ["malformed hex", { signature: `sha256=${hex.slice(0, -2)}zz` }],
    ["odd-length hex", { signature: `sha256=${hex.slice(1)}` }],
    ["upper-case hex", { signature: `sha256=${hex.toUpperCase()}` }],
    ["no prefix", { signature: hex }],
    ["a wrong prefix", { signature: `sha512=${hex}` }],
    ["a repeated header", { signature: `${sign(body)}, ${sign(body)}` }],
  ])("rejects %s with the fixed 401 and dispatches nothing", async (_name, options) => {
    const { handle, dispatch, log } = setup();
    await expectUnauthorized(await handle(delivery({ body, ...options })));
    expect(dispatch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects a body changed by one byte after signing", async () => {
    const { handle, dispatch } = setup();
    const original = bytes(JSON.stringify(PUSH));
    const tampered = Buffer.from(original);
    tampered[tampered.indexOf("1".charCodeAt(0))] = "2".charCodeAt(0);
    await expectUnauthorized(await handle(delivery({ body: tampered, signature: sign(original) })));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects the signature of a re-serialised body (the raw body is what is verified)", async () => {
    const { handle, dispatch } = setup();
    const compact = JSON.stringify(PUSH);
    const pretty = JSON.stringify(PUSH, null, 2);
    await expectUnauthorized(await handle(delivery({ body: compact, signature: sign(pretty) })));
    await expectUnauthorized(await handle(delivery({ body: pretty, signature: sign(compact) })));
    expect(dispatch).not.toHaveBeenCalled();
    // The same pretty body with its own signature is fine.
    expect((await handle(delivery({ body: pretty }))).status).toBe(202);
  });

  it("gives a missing signature exactly the same response as a wrong one", async () => {
    const { handle, log } = setup();
    const missing = await exposed(await handle(delivery({ signature: null })), log);
    const wrong = await exposed(
      await handle(delivery({ signature: sign("other", "another-secret-0123456789") })),
      log,
    );
    expect(missing).toBe(wrong);
  });

  it("does not parse JSON or read event headers before the signature is verified", async () => {
    const { handle, dispatch } = setup();
    const parse = vi.spyOn(JSON, "parse");
    let response: Response;
    try {
      response = await handle(delivery({ body: "{not json", event: null, signature: sign("{}") }));
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
    await expectUnauthorized(response);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("never verifies with an unconfigured secret: 500 even for an unsigned request", async () => {
    for (const value of [null, "", "0123456789abcde"]) {
      const { handle, dispatch, log } = setup({ readSecret: vi.fn(() => value) });
      const response = await handle(delivery({ signature: null }));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "misconfigured",
        message: "The server is not configured for webhooks.",
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledOnce();
    }
  });

  it("treats a throwing secret reader as misconfigured", async () => {
    const { handle, dispatch } = setup({
      readSecret: vi.fn(() => {
        throw new Error(`boom ${SECRET}`);
      }),
    });
    const response = await handle(delivery());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(SECRET);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("never touches the runtime or database on an unauthenticated request", async () => {
    // The only dependencies are readSecret (environment only) and dispatch; the dispatcher is
    // where task 6.3 reaches the runtime, so it must not run.
    const getRuntime = vi.fn();
    const dispatch = vi.fn<WebhookDispatch>(async () => {
      getRuntime();
    });
    const { handle } = setup({ dispatch });
    await handle(delivery({ signature: null }));
    await handle(delivery({ signature: sign("x") }));
    await handle(delivery({ contentType: "text/plain" }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(getRuntime).not.toHaveBeenCalled();
  });
});

describe("handleWebhookRequest: body and headers", () => {
  it("accepts a body of exactly the default cap", async () => {
    const { handle, dispatch } = setup();
    const prefix = '{"pad":"';
    const suffix = '"}';
    const body = Buffer.alloc(MAX_WEBHOOK_BODY_BYTES, "a");
    body.write(prefix, 0);
    body.write(suffix, MAX_WEBHOOK_BODY_BYTES - suffix.length);
    const response = await handle(
      delivery({ body, headers: { "content-length": String(body.length) } }),
    );
    expect(response.status).toBe(202);
    const payload = dispatch.mock.calls[0]?.[1] as { pad: string };
    expect(payload.pad).toHaveLength(MAX_WEBHOOK_BODY_BYTES - prefix.length - suffix.length);
  });

  it("refuses one byte over the default cap with 413, by Content-Length and while streaming", async () => {
    const { handle, dispatch } = setup();
    const body = Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1, " ");
    const declared = await handle(
      delivery({ body, headers: { "content-length": String(body.length) } }),
    );
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({
      error: "payload_too_large",
      message: "The body is too large.",
    });
    expect((await handle(delivery({ body }))).status).toBe(413);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("applies a custom cap at its boundary", async () => {
    const { handle, dispatch } = setup({ maxBodyBytes: 16 });
    const fits = '{"a":"01234567"}';
    expect(fits).toHaveLength(16);
    expect((await handle(delivery({ body: fits }))).status).toBe(202);
    expect((await handle(delivery({ body: '{"a":"012345678"}' }))).status).toBe(413);
    // A lying Content-Length larger than the cap is refused without reading.
    const lying = await handle(delivery({ body: "{}", headers: { "content-length": "17" } }));
    expect(lying.status).toBe(413);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("stops reading a streamed body once it passes the cap", async () => {
    const { handle } = setup({ maxBodyBytes: 1024 });
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(512));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign("") },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await handle(request)).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it("answers a body stream error with 400", async () => {
    const { handle, dispatch } = setup();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(`socket reset ${SECRET}`));
      },
    });
    const request = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const response = await handle(request);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(SECRET);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["an empty body", ""],
    ["a JSON array", "[1,2]"],
    ["a JSON string", '"push"'],
    ["JSON null", "null"],
  ])("answers %s with a valid signature with 400", async (_name, body) => {
    const { handle, dispatch } = setup();
    const response = await handle(delivery({ body }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_request",
      message: "The webhook request is malformed.",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each<[string, Options]>([
    ["a missing event header", { event: null }],
    ["an empty event header", { event: "" }],
    ["an event header with odd characters", { event: "push.x" }],
    ["an upper-case event header", { event: "Push" }],
    ["a malformed delivery id", { delivery: "a b" }],
  ])("answers %s on a signed request with 400", async (_name, options) => {
    const { handle, dispatch } = setup();
    expect((await handle(delivery(options))).status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses form-encoded deliveries with 415, signed or not", async () => {
    const { handle, dispatch, readSecret } = setup();
    const body = `payload=${encodeURIComponent(JSON.stringify(PUSH))}`;
    for (const signature of [sign(body), null]) {
      const response = await handle(
        delivery({ body, signature, contentType: "application/x-www-form-urlencoded" }),
      );
      expect(response.status).toBe(415);
      expect(response.headers.get("accept")).toBe("application/json");
      expect(await response.json()).toEqual({
        error: "unsupported_media_type",
        message: "Webhooks must be sent as application/json.",
      });
    }
    expect(readSecret).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([null, "text/plain", "application/jsonx", "application/json-patch+json"])(
    "refuses content type %s with 415",
    async (contentType) => {
      const { handle, dispatch } = setup();
      expect((await handle(delivery({ contentType }))).status).toBe(415);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("answers other methods with 405 and Allow: POST", async () => {
    const response = methodNotAllowed();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.json()).toEqual({ error: "method_not_allowed" });
  });
});

describe("handleWebhookRequest: dispatch failures", () => {
  const leaky = () => new Error(`token ghs_${SECRET} postgres://u:${SECRET}@db/x`);

  it("answers 500 with a fixed body when the dispatcher rejects, and logs no error text", async () => {
    const { handle, log } = setup({
      dispatch: vi.fn<WebhookDispatch>(async () => {
        throw leaky();
      }),
    });
    const response = await handle(delivery());
    expect(response.status).toBe(500);
    const text = await exposed(response, log);
    expect(text).toContain('"error":"internal_error"');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("ghs_");
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "webhook: dispatch failed",
      "event=push",
      `delivery=${DELIVERY}`,
    );
  });

  it("answers 500 when the dispatcher throws synchronously", async () => {
    const dispatch = vi.fn(() => {
      throw leaky();
    }) as unknown as WebhookDispatch;
    const { handle, log } = setup({ dispatch });
    const response = await handle(delivery());
    expect(response.status).toBe(500);
    expect(await exposed(response, log)).not.toContain(SECRET);
  });

  it("answers 202 when the dispatcher is still running after the wait, and logs a later failure safely", async () => {
    let reject: (error: Error) => void = () => undefined;
    const dispatch = vi.fn<WebhookDispatch>(
      () =>
        new Promise<void>((_resolve, rej) => {
          reject = rej;
        }),
    );
    const { handle, log } = setup({ dispatch, dispatchWaitMs: 5 });
    const response = await handle(delivery());
    expect(response.status).toBe(202);
    expect(log).not.toHaveBeenCalled();
    reject(leaky());
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    expect(log).toHaveBeenCalledWith(
      "webhook: dispatch failed",
      "event=push",
      `delivery=${DELIVERY}`,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
  });

  it("answers 202 when a slow dispatcher later succeeds", async () => {
    let resolve: () => void = () => undefined;
    const dispatch = vi.fn<WebhookDispatch>(
      () =>
        new Promise<void>((res) => {
          resolve = res;
        }),
    );
    const { handle, log } = setup({ dispatch, dispatchWaitMs: 5 });
    expect((await handle(delivery())).status).toBe(202);
    resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(log).not.toHaveBeenCalled();
  });

  it("never puts the secret in any response or log line", async () => {
    const cases: Options[] = [
      {},
      { signature: null },
      { signature: sign("x") },
      { body: "{bad" },
      { event: "ping" },
      { contentType: "text/plain" },
    ];
    for (const options of cases) {
      const { handle, log } = setup({
        dispatch: vi.fn<WebhookDispatch>(async () => {
          throw leaky();
        }),
      });
      const response = await handle(delivery(options));
      expect(await exposed(response, log)).not.toContain(SECRET);
    }
  });
});
