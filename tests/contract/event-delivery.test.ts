import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DomainEvent, EventName } from "@docmyrepos/core";

import { seedRepository } from "./support/seed";
import { ORIGIN, twoTenants, type TwoTenants } from "./support/tenants";

/**
 * Each action emits its event exactly once when it succeeds, and nothing when it is refused or
 * fails: invalid input, a conflict, a missing record, or a caller without the permission.
 */
let t: TwoTenants;
let host: ReturnType<TwoTenants["app"]>;
const events: DomainEvent[] = [];
let adminId: number;
let viewerId: number;

beforeAll(async () => {
  t = await twoTenants();
  const [admin] = await t.sql<{ id: number }>(
    "a",
    "INSERT INTO users (email, password_hash, role) VALUES ('root@a.example', 'x', 'admin') RETURNING id",
  );
  adminId = admin!.id;
  // The viewer is made through the admin API by a host that records nothing.
  host = t.app();
  const created = await host.routes.adminUsers.POST(
    send("POST", "/api/admin/users", await as(adminId), {
      email: "viewer@a.example",
      password: "viewer-pass-1234",
      role: "user",
    }),
  );
  viewerId = (await created.json()).user.id;
  await seedRepository(t.databases.a.url, { githubId: 31, owner: "a", name: "docs" }, [
    { path: "docs/guide.md", title: "Guide", body: "Paddling guide." },
  ]);
  host = t.app({ hooks: { onEvent: (event) => void events.push(event) } });
}, 60_000);

afterAll(async () => {
  await t?.close();
});

async function as(userId: number) {
  const ctx = await host.context(t.request("/", "a"));
  return (await host.issueSession(ctx!, userId, { secure: false })).split(";")[0] as string;
}

function send(method: string, path: string, cookie: string, body?: unknown) {
  return t.request(path, "a", {
    method,
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The names `action` emits, once its detached deliveries have run. */
async function emitted(action: () => Promise<Response>, status: number): Promise<EventName[]> {
  const from = events.length;
  const response = await action();
  expect(response.status, await response.clone().text()).toBe(status);
  await response.text();
  await new Promise((resolve) => setTimeout(resolve, 50));
  return events.slice(from).map((event) => event.name);
}

const id = (value: number) => ({ params: Promise.resolve({ id: String(value) }) });

describe("event delivery", () => {
  it("emits once on success and never on a refused or failed request", async () => {
    const admin = await as(adminId);
    const viewer = await as(viewerId);
    const r = host.routes;

    // Sign-in: a failure is its own event, never a success.
    const login = (password: string) =>
      r.authLogin.POST(
        send("POST", "/api/auth/login", "", { email: "viewer@a.example", password }),
      );
    expect(await emitted(() => login("viewer-pass-1234"), 200)).toEqual(["auth.login_succeeded"]);
    expect(await emitted(() => login("wrong-password-1"), 401)).toEqual(["auth.login_failed"]);
    expect(
      await emitted(() => r.authLogout.POST(send("POST", "/api/auth/logout", viewer)), 200),
    ).toEqual(["auth.logout"]);

    // Users.
    const newUser = { email: "ana@a.example", password: "ana-pass-12345", role: "user" };
    expect(
      await emitted(
        () => r.adminUsers.POST(send("POST", "/api/admin/users", viewer, newUser)),
        403,
      ),
    ).toEqual([]);
    let anaId = 0;
    expect(
      await emitted(async () => {
        const response = await r.adminUsers.POST(send("POST", "/api/admin/users", admin, newUser));
        anaId = (await response.clone().json()).user.id;
        return response;
      }, 201),
    ).toEqual(["user.created"]);
    expect(
      await emitted(() => r.adminUsers.POST(send("POST", "/api/admin/users", admin, newUser)), 409),
    ).toEqual([]);
    const patchAna = (body: unknown) =>
      r.adminUser.PATCH(send("PATCH", `/api/admin/users/${anaId}`, admin, body), id(anaId));
    expect(await emitted(() => patchAna({ role: "owner" }), 400)).toEqual([]);
    expect(await emitted(() => patchAna({ role: "admin" }), 200)).toEqual(["user.updated"]);

    // Settings: a stale version is a conflict.
    const view = await (
      await r.adminSettings.GET(
        t.request("/api/admin/settings", "a", { headers: { cookie: admin } }),
      )
    ).json();
    const save = (expectedVersion: number) =>
      r.adminSettings.PUT(
        send("PUT", "/api/admin/settings", admin, { expectedVersion, settings: view.settings }),
      );
    expect(await emitted(() => save(view.version + 7), 409)).toEqual([]);
    expect(await emitted(() => save(view.version), 200)).toEqual(["settings.updated"]);

    // Branding.
    const brand = (body: unknown) =>
      r.adminBranding.PUT(send("PUT", "/api/admin/branding", admin, body));
    expect(await emitted(() => brand({ coloredHeader: "yes" }), 400)).toEqual([]);
    expect(await emitted(() => brand({ orgName: "Acme" }), 200)).toEqual(["branding.updated"]);

    // Repository access: only a change of access is an event.
    const repo = (body: Record<string, unknown>) =>
      r.adminRepos.PATCH(send("PATCH", "/api/admin/repos", admin, { owner: "a", ...body }));
    expect(await emitted(() => repo({ name: "missing", isAllowed: false }), 404)).toEqual([]);
    expect(await emitted(() => repo({ name: "docs", isAllowed: true }), 200)).toEqual([]);
    expect(await emitted(() => repo({ name: "docs", isAllowed: false }), 200)).toEqual([
      "repo.access_changed",
    ]);
    expect(await emitted(() => repo({ name: "docs", isAllowed: true }), 200)).toEqual([
      "repo.access_changed",
    ]);

    // Tokens.
    const createToken = (body: unknown) =>
      r.accountTokens.POST(send("POST", "/api/account/tokens", admin, body));
    expect(await emitted(() => createToken({ name: "agent", expiryDays: -3 }), 400)).toEqual([]);
    let tokenId = 0;
    expect(
      await emitted(async () => {
        const response = await createToken({ name: "agent", expiryDays: 30 });
        tokenId = (await response.clone().json()).view.id;
        return response;
      }, 201),
    ).toEqual(["token.created"]);
    const revoke = (value: number) =>
      r.accountToken.DELETE(send("DELETE", `/api/account/tokens/${value}`, admin), id(value));
    expect(await emitted(() => revoke(tokenId + 1000), 404)).toEqual([]);
    expect(await emitted(() => revoke(tokenId), 200)).toEqual(["token.revoked"]);
    // Revoking again is answered as done, and changes nothing.
    expect(await emitted(() => revoke(tokenId), 200)).toEqual([]);

    // Comments.
    const comment = (body: string) =>
      r.comments.POST(
        send("POST", "/api/comments", admin, { repo: "a/docs", path: "docs/guide.md", body }),
      );
    expect(await emitted(() => comment("   "), 400)).toEqual([]);
    let commentId = 0;
    expect(
      await emitted(async () => {
        const response = await comment("Nice guide.");
        commentId = (await response.clone().json()).comment.id;
        return response;
      }, 201),
    ).toEqual(["comment.created"]);
    const remove = (value: number) =>
      r.comment.DELETE(send("DELETE", `/api/comments/${value}`, admin), id(value));
    expect(await emitted(() => remove(commentId + 1000), 404)).toEqual([]);
    expect(await emitted(() => remove(commentId), 200)).toEqual(["comment.deleted"]);

    await vi.waitFor(() => expect(events.every((e) => e.tenantId === "a")).toBe(true));
  });
});
