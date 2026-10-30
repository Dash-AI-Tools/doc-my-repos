import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startFakeProvider, type FakeProvider } from "../support/fake-provider";
import { ORIGIN, twoTenants, type TwoTenants } from "./support/tenants";

/**
 * Public access through the public API (public-access): a visitor without a session reads and
 * searches only what an admin marked public, asks only when allowed and within the shared caps, and
 * one tenant's public marks never apply to another. Every call goes through `app.routes`, the way
 * a host app's route files do.
 */

let t: TwoTenants;
let provider: FakeProvider;
let host: ReturnType<TwoTenants["app"]>;
let adminId: number;

const SEED = async (tenant: "a" | "b") => {
  for (const [id, name, text] of [
    [1, "pub", "OPEN-SENTINEL rotate the signing key with the rotate command"],
    [2, "closed", "CLOSED-SENTINEL rotate the signing key with the rotate command"],
  ] as const) {
    const [repo] = await t.sql<{ id: number }>(
      tenant,
      `INSERT INTO repos (github_id, owner, name, default_branch, visibility, html_url, docs_path)
       VALUES ($1, 'acme', $2, 'main', 'private', $3, 'docs') RETURNING id`,
      [id, name, `https://github.com/acme/${name}`],
    );
    await t.sql(
      tenant,
      `INSERT INTO documents (repo_id, path, title, blob_sha, size_bytes, body)
       VALUES ($1, 'docs/keys.md', 'Signing keys', $2, 10, $3)`,
      [repo!.id, `sha-${name}`, `# Keys\n\n## Rotate the signing key\n\n${text}`],
    );
  }
};

beforeAll(async () => {
  t = await twoTenants();
  provider = await startFakeProvider();
  provider.setDefault((request) =>
    request.stream
      ? { kind: "text", chunks: ["Run the rotate command [1]."], usage: { input: 30, output: 5 } }
      : { kind: "text", chunks: [JSON.stringify(["rotate signing key"])] },
  );
  await SEED("a");
  await SEED("b");
  const [admin] = await t.sql<{ id: number }>(
    "a",
    "INSERT INTO users (email, password_hash, role) VALUES ('root@a.example', 'x', 'admin') RETURNING id",
  );
  adminId = admin!.id;
  host = t.app();
}, 60_000);

afterAll(async () => {
  await provider?.close();
  await t?.close();
});

const adminCookie = async () => {
  const ctx = await host.context(t.request("/", "a"));
  return (await host.issueSession(ctx!, adminId, { secure: false })).split(";")[0] as string;
};
const write = (method: string, path: string, cookie: string, body?: unknown, tenant = "a") =>
  t.request(path, tenant, {
    method,
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const anonymousGet = (path: string, tenant: string) =>
  host.routes.search.GET!(t.request(path, tenant));
const anonymousAsk = (tenant: string, question = "How do I rotate the signing key?") =>
  host.routes.ask.POST!(
    t.request("/api/ask", tenant, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ question }),
    }),
  );

describe("a visitor without a session", () => {
  it("reaches nothing while nothing is public, on either tenant", async () => {
    for (const tenant of ["a", "b"]) {
      expect((await anonymousGet("/api/search?q=rotate", tenant)).status, tenant).toBe(401);
      expect((await anonymousAsk(tenant)).status, tenant).toBe(401);
      const asset = await host.routes.asset.GET!(
        t.request("/api/asset/acme/pub/docs/x.png", tenant),
      );
      expect(asset.status, tenant).toBe(401);
    }
  });

  it("searches only the public repositories once an admin marks one, and only on that tenant", async () => {
    const cookie = await adminCookie();
    const marked = await host.routes.adminRepos.PATCH!(
      write("PATCH", "/api/admin/repos", cookie, {
        owner: "acme",
        name: "pub",
        isPublic: true,
        confirmPrivate: true,
      }),
    );
    expect(marked.status, await marked.clone().text()).toBe(200);

    const found = await anonymousGet("/api/search?q=rotate", "a");
    expect(found.status).toBe(200);
    const body = JSON.stringify(await found.json());
    expect(body).toContain("pub");
    expect(body).not.toContain("closed");
    expect(body).not.toContain("CLOSED-SENTINEL");
    expect(found.headers.get("cache-control")).toBe("no-store");

    // Tenant b marked nothing: its visitors are refused, whatever tenant a did.
    expect((await anonymousGet("/api/search?q=rotate", "b")).status).toBe(401);
  });

  it("is refused search when an admin turns anonymous search off", async () => {
    const cookie = await adminCookie();
    const off = await host.routes.adminPublicAccess.PUT!(
      write("PUT", "/api/admin/public-access", cookie, { searchEnabled: false }),
    );
    expect(off.status).toBe(200);
    expect((await anonymousGet("/api/search?q=rotate", "a")).status).toBe(401);
    await host.routes.adminPublicAccess.PUT!(
      write("PUT", "/api/admin/public-access", cookie, { searchEnabled: true }),
    );
    expect((await anonymousGet("/api/search?q=rotate", "a")).status).toBe(200);
  });

  it("cannot tell a repository that is not public from one that does not exist, for images", async () => {
    const closed = await host.routes.asset.GET!(
      t.request("/api/asset/acme/closed/docs/x.png", "a"),
    );
    const missing = await host.routes.asset.GET!(t.request("/api/asset/acme/nope/docs/x.png", "a"));
    expect(closed.status).toBe(missing.status);
    expect(await closed.text()).toBe(await missing.text());
    expect(closed.headers.get("cache-control")).toBe(missing.headers.get("cache-control"));
  });

  it("is refused every route that is not for public content, whatever is public", async () => {
    const routes = host.routes;
    for (const call of [
      () => routes.status.GET!(t.request("/api/status", "a")),
      () => routes.comments.GET!(t.request("/api/comments?repo=acme/pub", "a")),
      () => routes.adminRepos.GET!(t.request("/api/admin/repos", "a")),
      () => routes.adminPublicAccess.GET!(t.request("/api/admin/public-access", "a")),
      () => routes.accountTokens.GET!(t.request("/api/account/tokens", "a")),
    ]) {
      expect((await call()).status).toBe(401);
    }
  });
});

describe("anonymous Ask", () => {
  const usage = (tenant: "a" | "b") =>
    t.sql<{ user_id: number | null; anonymous: boolean; outcome: string }>(
      tenant,
      "SELECT user_id, anonymous, outcome FROM ask_usage ORDER BY id",
    );

  it("answers from public repositories only, within the shared cap, recording only counts", async () => {
    const cookie = await adminCookie();
    const settings = await (
      await host.routes.adminSettings.GET!(
        t.request("/api/admin/settings", "a", { headers: { cookie } }),
      )
    ).json();
    await host.routes.adminAskCredentials.PUT!(
      write("PUT", "/api/admin/ask/credentials", cookie, {
        expectedVersion: settings.version,
        openaiBaseUrl: provider.openAiBaseUrl,
        secrets: { openai_api_key: "contract-key" },
      }),
    );
    const on = await host.routes.adminAsk.PUT!(
      write("PUT", "/api/admin/ask", cookie, {
        enabled: true,
        provider: "openai-compatible",
        model: "test-model",
      }),
    );
    expect(on.status, await on.clone().text()).toBe(200);

    // Anonymous Ask is still off.
    expect((await anonymousAsk("a")).status).toBe(401);

    const allowed = await host.routes.adminPublicAccess.PUT!(
      write("PUT", "/api/admin/public-access", cookie, {
        askEnabled: true,
        askQuestionsPerTenMinutes: 1,
      }),
    );
    expect(allowed.status).toBe(200);

    const first = await anonymousAsk("a");
    expect(first.status, await first.clone().text()).toBe(200);
    expect(first.headers.get("cache-control")).toContain("no-store");
    await first.text();
    const sent = JSON.stringify(provider.requests.map((r) => r.body));
    expect(sent).toContain("OPEN-SENTINEL");
    expect(sent).not.toContain("CLOSED-SENTINEL");

    // The cap is shared: the next visitor is refused with a retry time, and no model is called.
    const calls = provider.requests.length;
    const second = await anonymousAsk("a");
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(provider.requests).toHaveLength(calls);

    const rows = await usage("a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: null, anonymous: true, outcome: "ok" });
    expect(JSON.stringify(rows)).not.toContain("rotate the signing key");

    // Another tenant's visitors are not answered, and nothing is recorded there.
    expect((await anonymousAsk("b")).status).toBe(401);
    expect(await usage("b")).toEqual([]);
  });
});
