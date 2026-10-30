import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TENANT } from "@docmyrepos/core";
import type { App, RequestContext } from "@docmyrepos/server";

import { deny, pageContext, readerContext } from "./page-context";

const nav = vi.hoisted(() => ({ log: [] as string[] }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    nav.log.push(`redirect:${to}`);
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    nav.log.push("notFound");
    throw new Error("notFound");
  },
}));

const may = vi.hoisted(() => ({ allowed: false, asked: [] as string[] }));
vi.mock("@docmyrepos/server/internal/public-access/reader", () => ({
  ANONYMOUS: { kind: "anonymous" },
  MEMBER: { kind: "member" },
  anonymousMayUse: async (_ctx: unknown, need: string) => {
    may.asked.push(need);
    if (may.allowed === ("throw" as never)) throw new Error("db down");
    return may.allowed;
  },
}));

const USER = { id: 1, email: "a@example.com", role: "user" as const };

function appFor(over: Partial<RequestContext> | null): App {
  const ctx =
    over === null
      ? null
      : ({
          tenant: DEFAULT_TENANT,
          user: async () => USER,
          can: async () => true,
          ...over,
        } as unknown as RequestContext);
  return { pageContext: async () => ctx } as unknown as App;
}

beforeEach(() => {
  nav.log.length = 0;
  may.allowed = false;
  may.asked.length = 0;
});

describe("readerContext", () => {
  it("treats a signed-in user as a member without asking public access", async () => {
    const { reader } = await readerContext(appFor({}), "content");
    expect(reader.kind).toBe("member");
    expect(may.asked).toEqual([]);
  });

  it("shows a signed-in user the not-found page when the authorize hook refuses content.read", async () => {
    await expect(readerContext(appFor({ can: async () => false }), "content")).rejects.toThrow(
      "notFound",
    );
  });

  it("makes a visitor without a session anonymous only when public access allows the need", async () => {
    may.allowed = true;
    const { reader } = await readerContext(appFor({ user: async () => null }), "search");
    expect(reader.kind).toBe("anonymous");
    expect(may.asked).toEqual(["search"]);
  });

  it("sends a visitor to sign in when public access does not allow the need", async () => {
    for (const need of ["content", "search", "ask"] as const) {
      await expect(readerContext(appFor({ user: async () => null }), need)).rejects.toThrow(
        "redirect:/login",
      );
    }
    expect(may.asked).toEqual(["content", "search", "ask"]);
  });

  it("renders the not-found page for a request that matches no tenant, reading nothing", async () => {
    await expect(readerContext(appFor(null), "content")).rejects.toThrow("notFound");
    expect(may.asked).toEqual([]);
  });

  it("fails closed when public access cannot be read", async () => {
    may.allowed = "throw" as never;
    await expect(readerContext(appFor({ user: async () => null }), "content")).rejects.toThrow();
    expect(nav.log).not.toContain("notFound");
    // A thrown read is never turned into an anonymous reader: the error reaches the error page.
  });
});

describe("pageContext", () => {
  it("still sends every visitor without a session to sign in", async () => {
    await expect(pageContext(appFor({ user: async () => null }))).rejects.toThrow(
      "redirect:/login",
    );
    expect(may.asked).toEqual([]);
  });
});

describe("deny", () => {
  it("is the not-found page for a member and the sign-in page for an anonymous visitor", () => {
    expect(() => deny({ kind: "member" })).toThrow("notFound");
    expect(() => deny({ kind: "anonymous" })).toThrow("redirect:/login");
  });
});
