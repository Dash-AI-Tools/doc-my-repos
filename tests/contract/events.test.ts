import { generateKeyPairSync } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EVENT_NAMES, type DomainEvent } from "@docmyrepos/core";

import { FakeGitHub } from "../support/fake-github";
import { startFakeProvider, type FakeProvider } from "../support/fake-provider";
import { HOST_CONFIG } from "./host";
import { ORIGIN, twoTenants, type TwoTenants } from "./support/tenants";

/**
 * Every domain event of the catalogue reaches the host's `onEvent`, once the action behind it is
 * performed through the public API, and no other name does. Events carry ids and counts only.
 */
const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const MARKERS = ["SENTINEL-QUESTION", "SENTINEL-COMMENT", "SENTINEL-QUERY", "SENTINEL-PASSWORD"];

let t: TwoTenants;
let github: FakeGitHub;
let provider: FakeProvider;
const events: DomainEvent[] = [];
let host: ReturnType<TwoTenants["app"]>;
let adminId: number;

beforeAll(async () => {
  t = await twoTenants();
  github = new FakeGitHub({
    owner: "acme",
    repos: [
      {
        id: 101,
        name: "handbook",
        files: { "docs/keys.md": "# Keys\n\nTo rotate the signing key, run the rotate command." },
      },
      { id: 202, name: "broken", files: { "docs/a.md": "# A\n\nText." } },
    ],
  });
  github.fail({ path: /^\/repos\/acme\/broken\/git\/trees\//, status: 500 });
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(input instanceof Request ? input.url : input).origin === "https://api.github.com"
      ? github.fetch(input, init)
      : realFetch(input, init),
  );
  provider = await startFakeProvider();
  provider.setDefault((request) =>
    request.stream
      ? { kind: "text", chunks: ["Run the rotate command."], usage: { input: 30, output: 5 } }
      : { kind: "text", chunks: [JSON.stringify(["rotate signing key"])] },
  );
  const [admin] = await t.sql<{ id: number }>(
    "a",
    "INSERT INTO users (email, password_hash, role) VALUES ('root@a.example', 'x', 'admin') RETURNING id",
  );
  adminId = admin!.id;
  host = t.app({ hooks: { onEvent: (event) => void events.push(event) } });
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await provider?.close();
  await t?.close();
});

async function as(userId: number) {
  const ctx = await host.context(t.request("/", "a"));
  return (await host.issueSession(ctx!, userId, { secure: false })).split(";")[0] as string;
}

function write(method: string, path: string, cookie: string, body?: unknown) {
  return t.request(path, "a", {
    method,
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("the event catalogue", () => {
  it("reaches onEvent for every action, with no other names and no content", async () => {
    const admin = await as(adminId);
    const routes = host.routes;

    // Settings: the GitHub App, then a sync of the installation (one repository fails).
    const view = await (
      await routes.adminSettings.GET(
        t.request("/api/admin/settings", "a", { headers: { cookie: admin } }),
      )
    ).json();
    const saved = await routes.adminSettings.PUT(
      write("PUT", "/api/admin/settings", admin, {
        expectedVersion: view.version,
        settings: { ...view.settings, github: { appId: 1, installationId: github.installationId } },
        secrets: { github_private_key: PEM },
      }),
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
    const sync = await routes.sync.POST(
      t.request("/api/sync", "a", {
        method: "POST",
        headers: { authorization: `Bearer ${HOST_CONFIG.SYNC_SECRET}` },
      }),
    );
    expect(sync.status, await sync.clone().text()).toBeLessThan(500);
    // The admin's "Sync now" runs over the same tenant's workspace and database.
    const runs = async (tenant: "a" | "b") =>
      Number((await t.sql<{ n: string }>(tenant, "select count(*) as n from sync_runs"))[0]!.n);
    const before = await runs("a");
    const adminSync = await routes.adminSync.POST(write("POST", "/api/admin/sync", admin));
    expect(adminSync.status, await adminSync.clone().text()).toBeLessThan(500);
    expect(await runs("a")).toBe(before + 1);
    expect(await runs("b")).toBe(0);

    // Users and sign-in.
    const created = await routes.adminUsers.POST(
      write("POST", "/api/admin/users", admin, {
        email: "ana@a.example",
        password: "SENTINEL-PASSWORD-1",
        role: "user",
      }),
    );
    expect(created.status).toBe(201);
    const anaId = (await created.json()).user.id as number;
    const login = (password: string) =>
      routes.authLogin.POST(
        write("POST", "/api/auth/login", "", { email: "ana@a.example", password }),
      );
    expect((await login("SENTINEL-PASSWORD-1")).status).toBe(200);
    expect((await login("wrong-password-123")).status).toBe(401);
    const ana = await as(anaId);
    expect((await routes.authLogout.POST(write("POST", "/api/auth/logout", ana))).status).toBe(200);
    expect(
      (
        await routes.adminUser.PATCH(
          write("PATCH", `/api/admin/users/${anaId}`, admin, { role: "admin" }),
          {
            params: Promise.resolve({ id: String(anaId) }),
          },
        )
      ).status,
    ).toBe(200);

    // Tokens and the MCP endpoint.
    const token = await routes.accountTokens.POST(
      write("POST", "/api/account/tokens", admin, { name: "agent", expiryDays: 30 }),
    );
    expect(token.status).toBe(201);
    const { token: secret, view: tokenView } = await token.json();
    const mcp = await routes.mcp.POST(
      t.request("/api/mcp", "a", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_repositories", arguments: {} },
        }),
      }),
    );
    expect(mcp.status).toBe(200);
    await mcp.text();
    const revoked = await routes.accountToken.DELETE(
      write("DELETE", `/api/account/tokens/${tokenView.id}`, admin),
      { params: Promise.resolve({ id: String(tokenView.id) }) },
    );
    expect(revoked.status).toBe(200);

    // Reading: search, Ask, comments.
    const search = await routes.search.GET(
      t.request("/api/search?q=rotate%20SENTINEL-QUERY", "a", { headers: { cookie: admin } }),
    );
    expect(search.status).toBe(200);
    await host.routes.adminAskCredentials.PUT(
      write("PUT", "/api/admin/ask/credentials", admin, {
        expectedVersion: (
          await (
            await routes.adminSettings.GET(
              t.request("/api/admin/settings", "a", { headers: { cookie: admin } }),
            )
          ).json()
        ).version,
        openaiBaseUrl: provider.openAiBaseUrl,
        secrets: { openai_api_key: "contract-key" },
      }),
    );
    const on = await routes.adminAsk.PUT(
      write("PUT", "/api/admin/ask", admin, {
        enabled: true,
        provider: "openai-compatible",
        model: "test-model",
      }),
    );
    expect(on.status, await on.clone().text()).toBe(200);
    const asked = await routes.ask.POST(
      write("POST", "/api/ask", admin, { question: "How do I rotate the key? SENTINEL-QUESTION" }),
    );
    expect(asked.status).toBe(200);
    await asked.text();
    const comment = await routes.comments.POST(
      write("POST", "/api/comments", admin, {
        repo: "acme/handbook",
        path: "docs/keys.md",
        body: "Nice. SENTINEL-COMMENT",
      }),
    );
    expect(comment.status, await comment.clone().text()).toBe(201);
    const commentId = (await comment.json()).comment.id as number;
    const deleted = await routes.comment.DELETE(
      write("DELETE", `/api/comments/${commentId}`, admin),
      { params: Promise.resolve({ id: String(commentId) }) },
    );
    expect(deleted.status).toBe(200);

    // Administration: branding and repository access.
    expect(
      (
        await routes.adminBranding.PUT(
          write("PUT", "/api/admin/branding", admin, { orgName: "Acme" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await routes.adminRepos.PATCH(
          write("PATCH", "/api/admin/repos", admin, {
            owner: "acme",
            name: "handbook",
            isAllowed: false,
          }),
        )
      ).status,
    ).toBe(200);

    // Delivery is detached: let the queued events arrive.
    await vi.waitFor(() =>
      expect(new Set(events.map((e) => e.name))).toEqual(new Set(EVENT_NAMES)),
    );
    expect(events.every((e) => (EVENT_NAMES as readonly string[]).includes(e.name))).toBe(true);
    expect(events.every((e) => e.tenantId === "a" && e.schemaVersion === 1)).toBe(true);
    const dump = JSON.stringify(events);
    for (const marker of MARKERS) expect(dump).not.toContain(marker);
    expect(dump).not.toContain("BEGIN RSA PRIVATE KEY");
  }, 30_000);
});
