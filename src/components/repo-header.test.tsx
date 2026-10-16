// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RepoHeader, type RepoHeaderData } from "./repo-header";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const NOW = new Date("2026-10-10T12:00:00Z");

const BASE: RepoHeaderData = {
  owner: "acme",
  name: "api-service",
  description: "The public API.",
  htmlUrl: "https://github.com/acme/api-service",
  visibility: "public",
  isOkf: false,
  okfVersion: null,
  syncStatus: "ok",
  syncError: null,
  lastSyncedAt: new Date("2026-10-10T09:00:00Z"),
  docCount: 12,
};

function header(over: Partial<RepoHeaderData> = {}) {
  render(<RepoHeader repo={{ ...BASE, ...over }} now={NOW} />);
  return screen.getByTestId("repo-header");
}

describe("RepoHeader, public repository", () => {
  it("shows owner/name as the page title, the description and a breadcrumb home", () => {
    const el = header();
    expect(within(el).getByRole("heading", { level: 1 }).textContent).toBe("acme/api-service");
    expect(within(el).getByTestId("repo-description").textContent).toBe("The public API.");
    const crumbs = within(el).getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/");
    expect(crumbs.querySelector('[aria-current="page"]')?.textContent).toBe("acme/api-service");
  });

  it("links to the repository on GitHub, as an external link", () => {
    header();
    const link = screen.getByRole("link", { name: "View on GitHub" });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/api-service");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("falls back to github.com when the stored URL is unusable", () => {
    header({ htmlUrl: "javascript:alert(1)" });
    expect(screen.getByRole("link", { name: "View on GitHub" }).getAttribute("href")).toBe(
      "https://github.com/acme/api-service",
    );
  });

  it("shows the last synced time with an absolute time, and the document count", () => {
    const el = header();
    const time = el.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe("2026-10-10T09:00:00.000Z");
    expect(time?.getAttribute("title")).toBe("10 Oct 2026, 09:00 UTC");
    expect(time?.textContent).toContain("3 hours ago");
    expect(time?.textContent).toContain("(10 Oct 2026, 09:00 UTC)");
    expect(within(el).getByTestId("repo-meta").textContent).toContain("12 documents");
  });

  it("has no badges, no banners", () => {
    const el = header();
    expect(within(el).queryByTestId("private-badge")).toBeNull();
    expect(within(el).queryByTestId("okf-badge")).toBeNull();
    expect(within(el).queryByTestId("repo-sync-error")).toBeNull();
    expect(within(el).queryByTestId("repo-pending")).toBeNull();
  });

  it("says so when there is no description", () => {
    header({ description: null });
    expect(screen.getByTestId("repo-description").textContent).toBe("No description");
    cleanup();
    header({ description: "   " });
    expect(screen.getByTestId("repo-description").textContent).toBe("No description");
  });

  it("renders text from the repository as text", () => {
    const { container } = render(
      <RepoHeader
        repo={{ ...BASE, description: '<img src=x onerror="alert(1)"><b>bold</b>' }}
        now={NOW}
      />,
    );
    expect(container.querySelector("img, b")).toBeNull();
    expect(screen.getByTestId("repo-description").textContent).toContain("<img src=x");
  });
});

describe("RepoHeader, private repository", () => {
  it("shows the Private badge", () => {
    header({ visibility: "private" });
    expect(screen.getByTestId("private-badge").textContent).toBe("Private");
  });
});

describe("RepoHeader, OKF repository", () => {
  it("shows the OKF badge with the version", () => {
    header({ isOkf: true, okfVersion: "0.2" });
    expect(screen.getByTestId("okf-badge").textContent).toBe("OKF v0.2");
  });

  it("shows the OKF badge without a version, and not doubling a v", () => {
    header({ isOkf: true, okfVersion: null });
    expect(screen.getByTestId("okf-badge").textContent).toBe("OKF");
    cleanup();
    header({ isOkf: true, okfVersion: "v0.2" });
    expect(screen.getByTestId("okf-badge").textContent).toBe("OKF v0.2");
  });

  it("can be private and OKF at once", () => {
    header({ isOkf: true, okfVersion: "0.2", visibility: "private" });
    expect(screen.getByTestId("private-badge")).toBeTruthy();
    expect(screen.getByTestId("okf-badge")).toBeTruthy();
  });
});

describe("RepoHeader, errored repository", () => {
  it("shows the failure and that the previous content is still shown", () => {
    header({ syncStatus: "error", syncError: "GitHub rate limit exhausted; retry later" });
    const box = screen.getByTestId("repo-sync-error");
    expect(box.getAttribute("role")).toBe("status");
    expect(box.textContent).toContain("Last sync failed");
    expect(box.textContent).toContain("GitHub rate limit exhausted; retry later");
    expect(box.textContent).toContain("Showing previously synced content.");
    // the last successful sync time is still shown
    expect(screen.getByTestId("repo-meta").querySelector("time")).not.toBeNull();
  });

  it("says no content is stored when nothing was ever stored", () => {
    header({ syncStatus: "error", syncError: null, lastSyncedAt: null, docCount: 0 });
    const box = screen.getByTestId("repo-sync-error");
    expect(box.textContent).toContain("No content has been stored yet.");
    expect(box.textContent).not.toContain("previously");
  });

  it("renders the error text as text", () => {
    const { container } = render(
      <RepoHeader
        repo={{ ...BASE, syncStatus: "error", syncError: "<script>alert(1)</script>" }}
        now={NOW}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
  });
});

describe("RepoHeader, repository waiting for its first sync", () => {
  it("explains the pending state and shows 'Not synced yet'", () => {
    header({ syncStatus: "pending", lastSyncedAt: null, docCount: 0 });
    const box = screen.getByTestId("repo-pending");
    expect(box.getAttribute("role")).toBe("status");
    expect(box.textContent).toContain("Waiting for the first sync");
    expect(box.textContent).toContain("no content to show");
    const meta = screen.getByTestId("repo-meta");
    expect(meta.textContent).toContain("Not synced yet");
    expect(meta.textContent).toContain("No documents");
    expect(meta.querySelector("time")).toBeNull();
  });
});

describe("RepoHeader, sync state (tasks 12.2 and 12.3)", () => {
  const RUN = {
    trigger: "webhook" as const,
    startedAt: new Date("2026-10-10T11:00:00Z"),
    finishedAt: new Date("2026-10-10T11:30:00Z"),
    outcome: "unchanged" as const,
    warnings: 0,
  };

  it("shows a status chip for each state", () => {
    const cases: [Partial<RepoHeaderData>, string, string][] = [
      [{}, "Synced", "success"],
      [{ syncStatus: "error", syncError: "x" }, "Sync failed", "error"],
      [{ syncStatus: "pending", lastSyncedAt: null, docCount: 0 }, "Pending", "warning"],
      [
        { syncWarnings: [{ code: "too_large", message: "m", count: 1, paths: [] }] },
        "Synced with warnings",
        "warning",
      ],
    ];
    for (const [over, label, tone] of cases) {
      header(over);
      const chip = screen.getByTestId("repo-sync-status");
      expect(chip.textContent).toBe(label);
      expect(chip.getAttribute("data-tone")).toBe(tone);
      cleanup();
    }
  });

  it("shows the last run: trigger, when, outcome and warnings", () => {
    render(<RepoHeader repo={BASE} lastRun={{ ...RUN, warnings: 3 }} now={NOW} />);
    const run = screen.getByTestId("repo-last-run");
    expect(run.textContent).toContain("Last run: webhook, 30 minutes ago");
    expect(run.textContent).toContain("no changes, 3 warnings");
    expect(run.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-10T11:30:00.000Z");
  });

  it("shows a failed last run on an errored repository with the time of the stored content", () => {
    render(
      <RepoHeader
        repo={{
          ...BASE,
          syncStatus: "error",
          syncError: "GitHub rate limit exhausted; retry later",
        }}
        lastRun={{ ...RUN, outcome: "error" }}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("repo-last-run").textContent).toContain("failed");
    const stored = screen.getByTestId("repo-sync-error-stored");
    expect(stored.textContent).toContain("Last successful sync: 3 hours ago");
  });

  it("omits the last run when none is recorded", () => {
    header();
    expect(screen.queryByTestId("repo-last-run")).toBeNull();
  });

  it("lists the files the last sync left out in a disclosure", () => {
    header({
      syncWarnings: [
        {
          code: "docs_capped",
          message: "Only the first 2000 of 2030 documentation files were synced.",
          count: 30,
          paths: ["docs/a.md", "docs/<b>.md"],
        },
        {
          code: "too_large",
          message: "1 file larger than 256 KB was not synced.",
          count: 1,
          paths: ["docs/huge.md"],
        },
      ],
    });
    const box = screen.getByTestId("repo-sync-warnings");
    expect(box.getAttribute("role")).toBe("status");
    expect(box.textContent).toContain("Some files were not synced");
    expect(box.textContent).toContain("31 files in this repository are not shown.");
    const details = within(box).getByTestId("sync-warnings-details");
    expect(details.tagName).toBe("DETAILS");
    expect(details.hasAttribute("open")).toBe(false);
    const items = within(box).getAllByTestId("sync-warning");
    expect(items.map((i) => i.getAttribute("data-code"))).toEqual(["docs_capped", "too_large"]);
    expect(items[0]?.textContent).toContain("docs/<b>.md");
    expect(items[0]?.textContent).toContain("and 28 more files");
    expect(items[1]?.textContent).not.toContain("more file");
    expect(box.querySelector("b")).toBeNull();
  });

  it("shows no warning notice without warnings", () => {
    header({ syncWarnings: [] });
    expect(screen.queryByTestId("repo-sync-warnings")).toBeNull();
  });
});

describe("RepoHeader: Ask about this repository", () => {
  it("links to the Ask page limited to the repository when Ask is on", () => {
    render(<RepoHeader repo={BASE} now={NOW} askHref="/ask?repo=acme/api-service" />);
    const link = screen.getByRole("link", { name: "Ask about this repository" });
    expect(link.getAttribute("href")).toBe("/ask?repo=acme/api-service");
  });

  it("shows no link when Ask is off", () => {
    render(<RepoHeader repo={BASE} now={NOW} />);
    expect(screen.queryByRole("link", { name: "Ask about this repository" })).toBeNull();
    cleanup();
    render(<RepoHeader repo={BASE} now={NOW} askHref={null} />);
    expect(screen.queryByTestId("ask-about-repo")).toBeNull();
  });
});
