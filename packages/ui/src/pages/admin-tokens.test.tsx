import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminLayout } from "./admin-layout";

const state = vi.hoisted(() => ({
  enabled: true as boolean,
  role: "admin" as "admin" | "user",
  tokens: [] as unknown[] | "throws",
}));

vi.mock("@docmyrepos/server/internal/workspace", () => ({ mcpEnabled: async () => state.enabled }));
vi.mock("@docmyrepos/server/internal/auth/current-user", () => ({
  getCurrentUser: async () => ({ email: "v@example.com", role: state.role }),
}));
vi.mock("@docmyrepos/server/internal/mcp/token-views", () => ({
  loadAllTokenRows: async () => {
    if (state.tokens === "throws") throw new Error("db");
    return state.tokens;
  },
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not-found");
  },
  redirect: () => {
    throw new Error("redirect");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { AdminTokensPage } from "./admin-tokens";
import { testApp } from "./test-app";

// The admin layout reads the user from the request context; tests set the role through `state`.
const LAYOUT_APP = testApp(
  {},
  {
    user: async () => ({ id: 5, email: "v@example.com", role: state.role }) as never,
  },
);

const TEST_APP = testApp();

beforeEach(() => {
  state.enabled = true;
  state.role = "admin";
  state.tokens = [];
});

describe("admin tokens page", () => {
  it("answers 404 when the MCP endpoint is off", async () => {
    state.enabled = false;
    await expect(AdminTokensPage({ app: TEST_APP })).rejects.toThrow("not-found");
  });

  it("lists every user's tokens with the owner and no secret", async () => {
    state.tokens = [
      {
        id: 1,
        name: "bobs laptop",
        prefix: "abcd1234",
        createdAt: "2026-10-01T10:00:00.000Z",
        expiresAt: "2026-12-30T10:00:00.000Z",
        lastUsedAt: "2026-10-10T08:00:00.000Z",
        revokedAt: null,
        status: "active",
        owner: { id: 5, email: "bob@example.com" },
      },
    ];
    const out = renderToStaticMarkup(await AdminTokensPage({ app: TEST_APP }));
    expect(out).toContain("AI agent tokens");
    expect(out).toContain("bob@example.com");
    expect(out).toContain("bobs laptop");
    expect(out).toContain("10 Oct 2026, 08:00 UTC");
    expect(out).not.toMatch(/dmr_[A-Za-z0-9_-]{20}/);
  });

  it("says so when the tokens cannot be loaded", async () => {
    state.tokens = "throws";
    expect(renderToStaticMarkup(await AdminTokensPage({ app: TEST_APP }))).toContain(
      "could not be loaded",
    );
  });

  it("is behind the admin layout: a viewer sees access denied, not the page", async () => {
    state.role = "user";
    const out = renderToStaticMarkup(
      await AdminLayout({ app: LAYOUT_APP, children: "SECRET PAGE" }),
    );
    expect(out).toContain("Access denied");
    expect(out).not.toContain("SECRET PAGE");
  });
});
