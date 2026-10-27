import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedRepository } from "./support/seed";
import { ORIGIN, twoTenants, type TwoTenants } from "./support/tenants";

/**
 * Authentication through the public API: the default session and token checks are bound to the
 * tenant, and a host's `authenticate` replaces them everywhere.
 */
let t: TwoTenants;
let userA: number;

beforeAll(async () => {
  t = await twoTenants();
  // The same user id exists in both tenant databases.
  const [a] = await t.sql<{ id: number }>(
    "a",
    "INSERT INTO users (email, password_hash, role) VALUES ('ana@a.example', 'x', 'user') RETURNING id",
  );
  await t.sql(
    "b",
    "INSERT INTO users (email, password_hash, role) VALUES ('bo@b.example', 'x', 'user')",
  );
  userA = a!.id;
  for (const tenant of ["a", "b"] as const) {
    await seedRepository(t.databases[tenant].url, { githubId: 7, owner: tenant, name: "docs" }, [
      { path: "docs/readme.md", title: "Readme", body: "Kayak notes." },
    ]);
  }
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const cookieOf = (setCookie: string) => setCookie.split(";")[0] as string;

describe("default authentication, bound to the tenant", () => {
  const app = () => t.app();

  it("accepts a session for its tenant and refuses it replayed on another tenant", async () => {
    const host = app();
    const ctxA = await host.context(t.request("/", "a"));
    const cookie = cookieOf(await host.issueSession(ctxA!, userA, { secure: false }));
    const asA = await host.routes.search.GET(
      t.request("/api/search?q=kayak", "a", { headers: { cookie } }),
    );
    expect(asA.status).toBe(200);
    // User id `userA` exists in tenant b too, but the session was issued for tenant a.
    const asB = await host.routes.search.GET(
      t.request("/api/search?q=kayak", "b", { headers: { cookie } }),
    );
    expect(asB.status).toBe(401);
  });

  it("refuses an API token of one tenant on another tenant's MCP endpoint", async () => {
    const host = app();
    const ctxA = await host.context(t.request("/", "a"));
    const cookie = cookieOf(await host.issueSession(ctxA!, userA, { secure: false }));
    const created = await host.routes.accountTokens.POST(
      t.request("/api/account/tokens", "a", {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ name: "agent", expiryDays: 30 }),
      }),
    );
    expect(created.status).toBe(201);
    const { token } = (await created.json()) as { token: string };
    const initialize = (tenant: string) =>
      host.routes.mcp.POST(
        t.request("/api/mcp", tenant, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "t", version: "1" },
            },
          }),
        }),
      );
    expect((await initialize("a")).status).toBe(200);
    expect((await initialize("b")).status).toBe(401);
    // The context of an MCP request knows the token's user, through `authenticate`.
    const ctx = await host.context(
      t.request("/api/mcp", "a", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(await ctx!.user()).toMatchObject({ id: userA, email: "ana@a.example" });
  });
});

describe("a host's authenticate", () => {
  it("is used by gated APIs, with the user it returns", async () => {
    const host = t.app({
      hooks: {
        authenticate: async (request) =>
          request.headers.get("x-sso") === "ok"
            ? { id: 99, email: "sso@example.com", role: "user" }
            : null,
      },
    });
    const signedIn = await host.routes.search.GET(
      t.request("/api/search?q=kayak", "a", { headers: { "x-sso": "ok" } }),
    );
    expect(signedIn.status).toBe(200);
    const signedOut = await host.routes.search.GET(t.request("/api/search?q=kayak", "a"));
    expect(signedOut.status).toBe(401);
  });

  it("counts as signed out when it throws", async () => {
    const host = t.app({
      hooks: {
        authenticate: async () => {
          throw new Error("identity provider down");
        },
      },
    });
    const response = await host.routes.search.GET(t.request("/api/search?q=kayak", "a"));
    expect(response.status).toBe(401);
  });
});
