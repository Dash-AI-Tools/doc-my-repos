import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModerationData } from "@/lib/comments-moderation";

import AdminLayout from "../layout";
import AdminCommentsPage from "./page";

const state = vi.hoisted(() => ({
  data: null as unknown,
  role: "admin" as "admin" | "user",
  loaded: vi.fn(),
}));
vi.mock("@/server/admin/comments", () => ({
  loadModeration: async (raw: unknown) => {
    state.loaded(raw);
    return state.data;
  },
}));
vi.mock("@/server/auth/current-user", () => ({
  getCurrentUser: async () => ({ email: "v@example.com", role: state.role }),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const ready = (
  over: Partial<Extract<ModerationData, { status: "ready" }>> = {},
): ModerationData => ({
  status: "ready",
  enabled: true,
  filters: { state: null, githubRepoId: null, cursor: null },
  rows: [],
  nextCursor: null,
  now: "2026-10-10T12:00:00.000Z",
  ...over,
});

async function render(search: Record<string, string> = {}) {
  return renderToStaticMarkup(await AdminCommentsPage({ searchParams: Promise.resolve(search) }));
}

beforeEach(() => {
  state.role = "admin";
  state.loaded.mockClear();
  state.data = ready();
});

describe("admin comments page", () => {
  it("passes the query to the loader and lists nothing politely", async () => {
    const out = await render({ state: "orphaned" });
    expect(state.loaded).toHaveBeenCalledWith({ state: "orphaned" });
    expect(out).toContain("<h1");
    expect(out).toContain("No comments match.");
    expect(out).not.toContain("comments-off-notice");
  });

  it("explains that comments are off and still shows the list for purging", async () => {
    state.data = ready({ enabled: false });
    const out = await render();
    expect(out).toContain("comments-off-notice");
    expect(out).toContain("Comments are off");
    expect(out).toContain("remove");
    expect(out).toContain('aria-label="Filter comments"');
  });

  it("shows the count removed from the address", async () => {
    expect(await render({ removed: "3" })).toContain("3 comments removed permanently.");
    expect(await render({ removed: "1" })).toContain("1 comment removed permanently.");
    expect(await render({ deleted: "1" })).toContain("Comment deleted.");
    expect(await render({ removed: "<b>" })).not.toContain("removed permanently");
  });

  it("says when the list could not be loaded", async () => {
    state.data = { status: "unavailable" };
    expect(await render()).toContain("could not be loaded");
  });

  it("is behind the admin layout: viewers get the access-denied panel, not the page", async () => {
    state.role = "user";
    const tree = await AdminLayout({
      children: <AdminCommentsPage searchParams={Promise.resolve({})} />,
    });
    const out = renderToStaticMarkup(tree as React.ReactElement);
    expect(out).toContain("Access denied");
    expect(state.loaded).not.toHaveBeenCalled();
  });
});
