import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeData } from "@/server/home";

const loadHome = vi.fn<(deps: unknown, folderId?: number) => Promise<HomeData>>();
vi.mock("@/server/home", () => ({
  loadHome: (deps: unknown, folderId?: number) => loadHome(deps, folderId),
}));
const setup = vi.hoisted(() => ({ needed: false }));
vi.mock("@/server/onboarding", () => ({ setupNeeded: async () => setup.needed }));

import HomePage, { dynamic } from "./page";

const NOW = new Date("2026-10-10T12:00:00Z");

async function html(folder?: string | string[]): Promise<string> {
  return renderToStaticMarkup(await HomePage({ searchParams: Promise.resolve({ folder }) }));
}

/** The folder fields of an ok result when no folder is in use. */
const none = { folders: [], tabs: [], folder: null };

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
  folderId: null,
  isOkf: false,
  okfVersion: null,
  syncStatus: "ok" as const,
  syncError: null,
  lastSyncedAt: new Date("2026-10-10T11:00:00Z"),
  docCount: 2,
};

beforeEach(() => {
  loadHome.mockReset();
  setup.needed = false;
});

describe("home page", () => {
  it("is rendered per request, not statically", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("renders the heading, the search bar and the grid", async () => {
    loadHome.mockResolvedValue({
      ...none,
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
      ...none,
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

    loadHome.mockResolvedValue({
      ...none,
      status: "ok",
      loadedAt: NOW,
      starred: [],
      repos: [repo],
    });
    const plain = await html();
    expect(plain).not.toMatch(/okf/i);
  });

  it("shows a Starred section above Repositories, and the empty state only when nothing exists at all", async () => {
    loadHome.mockResolvedValue({
      ...none,
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
      ...none,
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
    loadHome.mockResolvedValue({ ...none, status: "ok", loadedAt: NOW, starred: [], repos: [] });
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
    await expect(HomePage({ searchParams: Promise.resolve({}) })).rejects.toThrow("bug");
  });

  it("shows the setup banner, linking to the instructions, only when setup is needed", async () => {
    loadHome.mockResolvedValue({ ...none, status: "ok", starred: [], repos: [], loadedAt: NOW });
    expect(await html()).not.toContain("setup-banner");
    setup.needed = true;
    const out = await html();
    expect(out).toContain("setup-banner");
    expect(out).toContain('href="/admin/workspace?setup=1"');
  });

  describe("folders (optional)", () => {
    const inFolder = { ...repo, id: 7, name: "pay-api", folderId: 5 };
    const payments = {
      id: 5,
      name: "Payments",
      description: "<b>Money</b> things",
      repos: [inFolder],
    };

    it("shows no tab bar and no folder section when no folder is in use", async () => {
      loadHome.mockResolvedValue({
        ...none,
        status: "ok",
        loadedAt: NOW,
        starred: [],
        repos: [repo],
      });
      const out = await html();
      expect(out).not.toContain("home-tabs");
      expect(out).not.toContain("Payments");
      expect(out).toContain("Repositories");
    });

    it("shows a section per folder with its description as literal text, before Repositories", async () => {
      loadHome.mockResolvedValue({
        ...none,
        status: "ok",
        loadedAt: NOW,
        starred: [],
        folders: [payments],
        repos: [repo],
      });
      const out = await html();
      expect(out).toContain("Payments");
      expect(out).toContain("&lt;b&gt;Money&lt;/b&gt; things");
      expect(out).not.toContain("<b>Money</b>");
      expect(out.indexOf("Payments")).toBeLessThan(out.indexOf("Repositories"));
      expect(out).toContain('href="/acme/pay-api"');
    });

    it("omits Repositories when everything is in folders, and is not the empty state", async () => {
      loadHome.mockResolvedValue({
        ...none,
        status: "ok",
        loadedAt: NOW,
        starred: [],
        folders: [payments],
        repos: [],
      });
      const out = await html();
      expect(out).not.toContain("Repositories");
      expect(out).not.toContain("Nothing synced yet");
    });

    it("shows the tab bar with All current, and links to each folder", async () => {
      loadHome.mockResolvedValue({
        ...none,
        status: "ok",
        loadedAt: NOW,
        starred: [],
        repos: [repo],
        tabs: [
          { id: 5, name: "Payments" },
          { id: 9, name: "Ops" },
        ],
      });
      const out = await html();
      expect(out).toContain('data-testid="home-tabs"');
      expect(out).toMatch(
        /<a[^>]*href="\/"[^>]*aria-current="page"[^>]*>All<\/a>|<a[^>]*aria-current="page"[^>]*href="\/"[^>]*>All<\/a>/,
      );
      expect(out).toContain('href="/?folder=5"');
      expect(out).toContain('href="/?folder=9"');
      expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    });

    it("passes a numeric folder parameter to the loader and shows only that folder, marked current", async () => {
      loadHome.mockResolvedValue({
        ...none,
        status: "ok",
        loadedAt: NOW,
        starred: [],
        repos: [repo],
        tabs: [{ id: 5, name: "Payments" }],
        folder: payments,
      });
      const out = await html("5");
      expect(loadHome).toHaveBeenLastCalledWith({}, 5);
      expect(out).toContain('href="/acme/pay-api"');
      expect(out).not.toContain('href="/acme/api"');
      expect(out).toMatch(/aria-current="page"[^>]*>Payments</);
    });

    it.each([undefined, "", "abc", "0", "-1", "1.5", "5x", "99999999999", ["5", "6"]])(
      "ignores an unusable folder parameter %j",
      async (value) => {
        loadHome.mockResolvedValue({
          ...none,
          status: "ok",
          loadedAt: NOW,
          starred: [],
          repos: [repo],
        });
        await html(value);
        expect(loadHome).toHaveBeenLastCalledWith({}, undefined);
      },
    );
  });
});
