import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Feature } from "@docmyrepos/core";

import { seedRepository } from "./support/seed";
import { ORIGIN, twoTenants, type TwoTenants } from "./support/tenants";

/**
 * A feature the host's `checkEntitlement` denies behaves exactly as if an administrator had turned
 * it off, and the stored settings stay as they are.
 */
let t: TwoTenants;
let adminId: number;

beforeAll(async () => {
  t = await twoTenants();
  const [admin] = await t.sql<{ id: number }>(
    "a",
    "INSERT INTO users (email, password_hash, role) VALUES ('root@a.example', 'x', 'admin') RETURNING id",
  );
  adminId = admin!.id;
  await seedRepository(t.databases.a.url, { githubId: 21, owner: "a", name: "docs" }, [
    { path: "docs/guide.md", title: "Guide", body: "Paddling guide." },
  ]);
  // Ask set up and switched on through the admin APIs, as an administrator does it.
  const host = t.app();
  const cookie = await signedIn(host);
  const write = (path: string, body: unknown) =>
    t.request(path, "a", {
      method: "PUT",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const settings = await (
    await host.routes.adminSettings.GET(
      t.request("/api/admin/settings", "a", { headers: { cookie } }),
    )
  ).json();
  const saved = await host.routes.adminAskCredentials.PUT(
    write("/api/admin/ask/credentials", {
      expectedVersion: settings.version,
      openaiBaseUrl: "http://127.0.0.1:9/v1",
      secrets: { openai_api_key: "contract-test-key" },
    }),
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  const on = await host.routes.adminAsk.PUT(
    write("/api/admin/ask", { enabled: true, provider: "openai-compatible", model: "test-model" }),
  );
  expect(on.status, await on.clone().text()).toBe(200);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

async function signedIn(host: ReturnType<TwoTenants["app"]>) {
  const ctx = await host.context(t.request("/", "a"));
  return (await host.issueSession(ctx!, adminId, { secure: false })).split(";")[0] as string;
}

const entitledTo = (denied: readonly Feature[]) =>
  t.app({ hooks: { checkEntitlement: (_ctx, feature) => !denied.includes(feature) } });

describe("entitlements", () => {
  it("make Ask answer as when it is off, and leave its settings stored", async () => {
    const ask = async (denied: readonly Feature[]) => {
      const host = entitledTo(denied);
      const cookie = await signedIn(host);
      return host.routes.ask.POST(
        t.request("/api/ask", "a", {
          method: "POST",
          headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "How do I paddle?" }] }),
        }),
      );
    };
    expect((await ask(["ask"])).status).toBe(404);
    // Entitled, Ask is on: the request gets past availability (the fake provider is unreachable).
    expect((await ask([])).status).not.toBe(404);
    const [row] = await t.sql<{ enabled: boolean }>("a", "select enabled from ask_settings");
    expect(row?.enabled).toBe(true);
  });

  it("make the MCP endpoint answer 404, as when it is off", async () => {
    const response = await entitledTo(["mcp"]).routes.mcp.POST(
      t.request("/api/mcp", "a", { method: "POST" }),
    );
    expect(response.status).toBe(404);
    const entitled = await entitledTo([]).routes.mcp.POST(
      t.request("/api/mcp", "a", { method: "POST" }),
    );
    expect(entitled.status).toBe(401);
  });

  it("make comments answer 404, as when they are off", async () => {
    const list = async (denied: readonly Feature[]) => {
      const host = entitledTo(denied);
      const cookie = await signedIn(host);
      return host.routes.comments.GET(
        t.request("/api/comments?repo=a/docs&path=docs/guide.md", "a", { headers: { cookie } }),
      );
    };
    expect((await list(["comments"])).status).toBe(404);
    expect((await list([])).status).toBe(200);
  });
});
