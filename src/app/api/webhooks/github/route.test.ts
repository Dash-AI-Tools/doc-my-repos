import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "SENTINEL-webhook-secret-91c4d2";

// The route must authenticate from the environment alone: building the runtime or the database
// handle on an unauthenticated request is a failure.
const getRuntime = vi.fn(() => {
  throw new Error("runtime must not be built");
});
const getDb = vi.fn(() => {
  throw new Error("database must not be opened");
});
vi.mock("@/server/runtime", () => ({
  getRuntime,
  reloadRuntime: getRuntime,
  createRuntime: getRuntime,
}));
vi.mock("@/server/db/client", () => ({ getDb, createDb: getDb }));

const dispatch = vi.fn(async () => undefined);
vi.mock("@/server/webhooks/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/webhooks/service")>();
  return { ...actual, getWebhookDispatch: vi.fn(() => dispatch) };
});

const { DELETE, GET, PATCH, POST, PUT, dynamic, runtime } = await import("./route");

const BODY = JSON.stringify({ ref: "refs/heads/main", repository: { id: 101 } });

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function request(method: string, headers: Record<string, string> = {}, body?: string) {
  return new Request("http://localhost/api/webhooks/github", { method, headers, body });
}

function signed(signature: string | null, event = "push"): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  };
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  return request("POST", headers, BODY);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", `  ${SECRET}\n`);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/webhooks/github route", () => {
  it("is dynamic and runs on the Node.js runtime", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(runtime).toBe("nodejs");
  });

  it("accepts a delivery signed with GITHUB_WEBHOOK_SECRET and dispatches it", async () => {
    const response = await POST(signed(sign(BODY)));
    expect(response.status).toBe(202);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      "push",
      JSON.parse(BODY),
      "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    );
  });

  it("answers ping with 200", async () => {
    const response = await POST(signed(sign(BODY), "ping"));
    expect(response.status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects missing and wrong signatures identically, without the runtime or database", async () => {
    const texts: string[] = [];
    for (const signature of [null, sign(BODY, "another-secret-0123456789")]) {
      const response = await POST(signed(signature));
      expect(response.status).toBe(401);
      texts.push(await response.text());
    }
    expect(texts[0]).toBe(texts[1]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(getRuntime).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("answers 500 to everyone when the secret is missing or too short", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const value of ["", "short-secret"]) {
        vi.stubEnv("GITHUB_WEBHOOK_SECRET", value);
        const response = await POST(signed(sign(BODY, value)));
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ error: "misconfigured" });
      }
      expect(JSON.stringify(error.mock.calls)).not.toContain("short-secret");
    } finally {
      error.mockRestore();
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(getRuntime).not.toHaveBeenCalled();
  });

  it.each<[string, (request: Request) => Response]>([
    ["GET", GET],
    ["PUT", PUT],
    ["PATCH", PATCH],
    ["DELETE", DELETE],
  ])("answers %s with 405 and Allow: POST", async (method, handler) => {
    const response = handler(
      request(method, { "x-hub-signature-256": sign(BODY) }, method === "GET" ? undefined : BODY),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
