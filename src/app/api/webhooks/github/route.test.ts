import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { Secret } from "@/server/config/secret";

const SECRET = "SENTINEL-webhook-secret-91c4d2";

// The route must authenticate from the environment alone: building the runtime or the database
// handle on an unauthenticated request is a failure.
// The stored webhook secret comes from the workspace; the database is never opened here.
const stored = vi.hoisted(() => ({ secret: null as string | null }));
const getWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@/server/workspace", () => ({ getWorkspace }));
const getDb = vi.fn(() => {
  throw new Error("database must not be opened");
});
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
  stored.secret = SECRET;
  getWorkspace.mockImplementation(async () => ({
    webhookSecret: stored.secret === null ? null : new Secret(stored.secret),
  }));
});

describe("/api/webhooks/github route", () => {
  it("is dynamic and runs on the Node.js runtime", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(runtime).toBe("nodejs");
  });

  it("accepts a delivery signed with the stored webhook secret and dispatches it", async () => {
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

  it("rejects missing and wrong signatures identically, without opening the database", async () => {
    const texts: string[] = [];
    for (const signature of [null, sign(BODY, "another-secret-0123456789")]) {
      const response = await POST(signed(signature));
      expect(response.status).toBe(401);
      texts.push(await response.text());
    }
    expect(texts[0]).toBe(texts[1]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("answers 401 to everyone, signed or not, while no webhook secret is stored", async () => {
    stored.secret = null;
    for (const signature of [null, sign(BODY), sign(BODY, "")]) {
      const response = await POST(signed(signature));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("answers 401 when the settings cannot be loaded, without leaking why", async () => {
    getWorkspace.mockRejectedValue(new Error(`boom ${SECRET}`));
    const response = await POST(signed(sign(BODY)));
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(SECRET);
    expect(dispatch).not.toHaveBeenCalled();
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
