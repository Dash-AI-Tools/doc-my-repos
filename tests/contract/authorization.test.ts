import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Action } from "@docmyrepos/core";

import { seedRepository } from "./support/seed";
import { ORIGIN, twoTenants, type TwoTenants } from "./support/tenants";

/**
 * A host's `authorize` decides every permission check, through the public API only: a deny-list
 * blocks exactly what it names, and a hook that throws denies.
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
  await seedRepository(t.databases.a.url, { githubId: 11, owner: "a", name: "docs" }, [
    { path: "docs/guide.md", title: "Guide", body: "Paddling guide." },
  ]);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

function hostDenying(denied: readonly Action[]) {
  return t.app({
    hooks: {
      authorize: async (ctx, action) => {
        if (denied.includes(action)) return false;
        return (await ctx.user()) !== null;
      },
    },
  });
}

async function signedIn(host: ReturnType<TwoTenants["app"]>) {
  const ctx = await host.context(t.request("/", "a"));
  const setCookie = await host.issueSession(ctx!, adminId, { secure: false });
  return setCookie.split(";")[0] as string;
}

const postComment = (cookie: string) =>
  t.request("/api/comments", "a", {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ repo: "a/docs", path: "docs/guide.md", body: "Nice guide." }),
  });

const commentCount = async () =>
  Number((await t.sql<{ n: string }>("a", "select count(*) as n from doc_comments"))[0]!.n);

describe("a host's authorize", () => {
  it("blocks posting a comment it denies, and stores nothing", async () => {
    const host = hostDenying(["comment.create"]);
    const response = await host.routes.comments.POST(postComment(await signedIn(host)));
    expect(response.status).toBe(403);
    expect(await commentCount()).toBe(0);
  });

  it("lets the same comment through when it allows it", async () => {
    const host = hostDenying([]);
    const response = await host.routes.comments.POST(postComment(await signedIn(host)));
    expect(response.status).toBe(201);
    expect(await commentCount()).toBe(1);
  });

  it("keeps an administrator out of the admin APIs when it denies admin.manage", async () => {
    const cookie = await signedIn(hostDenying(["admin.manage"]));
    const denied = await hostDenying(["admin.manage"]).routes.adminUsers.GET(
      t.request("/api/admin/users", "a", { headers: { cookie } }),
    );
    expect(denied.status).toBe(403);
    const allowed = await hostDenying([]).routes.adminUsers.GET(
      t.request("/api/admin/users", "a", { headers: { cookie } }),
    );
    expect(allowed.status).toBe(200);
  });

  it("denies when it throws", async () => {
    const host = t.app({
      hooks: {
        authorize: async () => {
          throw new Error("policy service down");
        },
      },
    });
    const cookie = await signedIn(host);
    const response = await host.routes.search.GET(
      t.request("/api/search?q=paddling", "a", { headers: { cookie } }),
    );
    expect(response.status).toBe(403);
  });
});
