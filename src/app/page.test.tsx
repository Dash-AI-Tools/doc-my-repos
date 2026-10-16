import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeData } from "@/server/home";

const loadHome = vi.fn<() => Promise<HomeData>>();
vi.mock("@/server/home", () => ({ loadHome: () => loadHome() }));

import HomePage, { dynamic } from "./page";

const NOW = new Date("2026-10-10T12:00:00Z");

async function html(): Promise<string> {
  return renderToStaticMarkup(await HomePage());
}

const repo = {
  id: 1,
  owner: "acme",
  name: "api",
  description: "API",
  htmlUrl: "https://github.com/acme/api",
  visibility: "public" as const,
  isAllowed: true,
  starPosition: null,
  isStarred: false,
  isOkf: false,
  okfVersion: null,
  syncStatus: "ok" as const,
  syncError: null,
  lastSyncedAt: new Date("2026-10-10T11:00:00Z"),
  docCount: 2,
};

beforeEach(() => {
  loadHome.mockReset();
});

describe("home page", () => {
  it("is rendered per request, not statically", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("renders the heading, the search bar and the grid", async () => {
    loadHome.mockResolvedValue({
      status: "ok",
      loadedAt: NOW,
      starred: [],
      repos: [repo, { ...repo, id: 2, name: "hidden", visibility: "private" }],
    });
    const out = await html();
    expect(out).toMatch(/<h1[^>]*>Documentation portal<\/h1>/);
    expect(out).toContain('action="/search"');
    expect(out).toContain('name="q"');
    expect(out).toContain('href="/acme/api"');
    expect(out).toContain('href="/acme/hidden"');
    expect(out).toContain("Private");
    expect(out).toContain("1 hour ago");
    expect(out).not.toContain("Nothing synced yet");
  });

  it("shows the OKF badge on OKF cards only, and no OKF wording for plain repositories (task 11.1)", async () => {
    loadHome.mockResolvedValue({
      status: "ok",
      loadedAt: NOW,
      starred: [],
      repos: [
        { ...repo, id: 2, name: "kb", isOkf: true, okfVersion: "0.2" },
        { ...repo, id: 3, name: "plain" },
      ],
    });
    const out = await html();
    expect(out.match(/data-testid="okf-badge"/g)).toHaveLength(1);
    expect(out).toContain("OKF v0.2");

    loadHome.mockResolvedValue({ status: "ok", loadedAt: NOW, starred: [], repos: [repo] });
    const plain = await html();
    expect(plain).not.toMatch(/okf/i);
  });

  it("shows a Starred section above Repositories, and the empty state only when nothing exists at all", async () => {
    loadHome.mockResolvedValue({
      status: "ok",
      loadedAt: NOW,
      starred: [{ ...repo, id: 3, name: "lead", isStarred: true, starPosition: 0 }],
      repos: [repo],
    });
    const out = await html();
    expect(out.indexOf("Starred")).toBeGreaterThan(-1);
    expect(out.indexOf("Starred")).toBeLessThan(out.indexOf("Repositories"));
    expect(out).not.toContain("Nothing synced yet");

    // Everything starred: no Repositories section, and still not the empty state.
    loadHome.mockResolvedValue({
      status: "ok",
      loadedAt: NOW,
      starred: [{ ...repo, isStarred: true, starPosition: 0 }],
      repos: [],
    });
    const all = await html();
    expect(all).toContain("Starred");
    expect(all).not.toContain("Repositories");
    expect(all).not.toContain("Nothing synced yet");
  });

  it("renders the empty state, with the search bar, when nothing is synced", async () => {
    loadHome.mockResolvedValue({ status: "ok", loadedAt: NOW, starred: [], repos: [] });
    const out = await html();
    expect(out).toContain("Nothing synced yet");
    expect(out).toContain('action="/search"');
    expect(out).not.toContain('data-testid="repo-card"');
  });

  it("renders the error state, with the page heading, when the read fails", async () => {
    loadHome.mockResolvedValue({ status: "error", loadedAt: NOW });
    const out = await html();
    expect(out).toContain("Repositories could not be loaded");
    expect(out).toContain('href="/"');
    expect(out).toMatch(/<h1[^>]*>Documentation portal<\/h1>/);
    expect(out).not.toContain("Nothing synced yet");
  });

  it("lets an unexpected error reach the error boundary", async () => {
    loadHome.mockImplementation(() => Promise.reject(new TypeError("bug")));
    await expect(HomePage()).rejects.toThrow("bug");
  });
});
