import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  enabled: true as boolean | "throws",
  user: { id: 3, email: "u@example.com", role: "user" } as null | {
    id: number;
    email: string;
    role: "admin" | "user";
  },
  tokens: [] as unknown[] | "throws",
  asked: vi.fn(),
}));

vi.mock("@/server/workspace", () => ({
  mcpEnabled: async () => {
    if (state.enabled === "throws") throw new Error("db");
    return state.enabled;
  },
}));
vi.mock("@/server/auth/current-user", () => ({ getCurrentUser: async () => state.user }));
vi.mock("@/server/mcp/token-views", () => ({
  loadOwnTokenRows: async (userId: number) => {
    state.asked(userId);
    if (state.tokens === "throws") throw new Error("db");
    return state.tokens;
  },
}));
vi.mock("@/server/mcp/tokens", () => ({ MAX_ACTIVE_TOKENS: 10 }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not-found");
  },
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import AgentAccessPage from "./page";

const token = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: "laptop",
  prefix: "abcd1234",
  createdAt: "2026-10-01T10:00:00.000Z",
  expiresAt: "2026-12-30T10:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  status: "active",
  ...over,
});

beforeEach(() => {
  state.enabled = true;
  state.user = { id: 3, email: "u@example.com", role: "user" };
  state.tokens = [];
  state.asked.mockClear();
});

describe("agent access page", () => {
  it("answers 404 when the MCP endpoint is off, before it looks at the user or the tokens", async () => {
    state.enabled = false;
    await expect(AgentAccessPage()).rejects.toThrow("not-found");
    expect(state.asked).not.toHaveBeenCalled();
  });

  it("answers 404 when the setting cannot be read", async () => {
    state.enabled = "throws";
    await expect(AgentAccessPage()).rejects.toThrow("not-found");
  });

  it("sends a signed-out visitor to sign in", async () => {
    state.user = null;
    await expect(AgentAccessPage()).rejects.toThrow("redirect:/login");
    expect(state.asked).not.toHaveBeenCalled();
  });

  it("lists only the signed-in user's tokens and shows no secret", async () => {
    state.tokens = [token({ name: "my laptop" })];
    const out = renderToStaticMarkup(await AgentAccessPage());
    expect(state.asked).toHaveBeenCalledWith(3);
    expect(out).toContain("<h1");
    expect(out).toContain("AI agent access");
    expect(out).toContain("my laptop");
    expect(out).toContain("dmr_abcd1234…");
    expect(out).not.toMatch(/dmr_[A-Za-z0-9_-]{20}/);
    expect(out).not.toContain("tokenHash");
  });

  it("says so, with no form, when the tokens cannot be loaded", async () => {
    state.tokens = "throws";
    const out = renderToStaticMarkup(await AgentAccessPage());
    expect(out).toContain("could not be loaded");
    expect(out).not.toContain("Create token");
  });
});
