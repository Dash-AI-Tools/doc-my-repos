// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RepoCard, documentCountLabel, okfBadgeLabel, type RepoCardData } from "./repo-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-10-10T12:00:00Z");

const BASE: RepoCardData = {
  owner: "acme",
  name: "api-service",
  description: "The public API.",
  visibility: "public",
  isOkf: false,
  okfVersion: null,
  syncStatus: "ok",
  syncError: null,
  lastSyncedAt: new Date("2026-10-10T09:00:00Z"),
  docCount: 12,
};

function card(over: Partial<RepoCardData> = {}) {
  render(
    <ul>
      <RepoCard repo={{ ...BASE, ...over }} now={NOW} />
    </ul>,
  );
  return screen.getByTestId("repo-card");
}

afterEach(cleanup);

describe("RepoCard", () => {
  it("links the title to the repository space with one anchor and no other interactive element", () => {
    const el = card();
    const link = within(el).getByRole("link", { name: "acme/api-service" });
    expect(link.getAttribute("href")).toBe("/acme/api-service");
    expect(el.querySelectorAll("a, button, input, select, textarea, [tabindex]")).toHaveLength(1);
    expect(within(el).getByRole("heading", { level: 3 })).toBe(link.parentElement);
  });

  it("encodes odd characters in the link", () => {
    card({ owner: "a b", name: "c#d" });
    expect(screen.getByRole("link").getAttribute("href")).toBe("/a%20b/c%23d");
  });

  it("shows description, document count and last synced time, relative and absolute", () => {
    const el = card();
    expect(el.textContent).toContain("The public API.");
    expect(el.textContent).toContain("12 documents");
    const time = el.querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe("2026-10-10T09:00:00.000Z");
    expect(time?.getAttribute("title")).toBe("10 Oct 2026, 09:00 UTC");
    expect(time?.textContent).toBe("3 hours ago (10 Oct 2026, 09:00 UTC)");
  });

  it("shows the private badge only for a private repository", () => {
    expect(card({ visibility: "private" }).querySelector("[data-testid=private-badge]")).not.toBe(
      null,
    );
    expect(screen.getByTestId("private-badge").textContent).toBe("Private");
    cleanup();
    expect(card({ visibility: "public" }).querySelector("[data-testid=private-badge]")).toBeNull();
  });

  it("shows an OKF badge with the version when present", () => {
    card({ isOkf: true, okfVersion: "0.2" });
    expect(screen.getByTestId("okf-badge").textContent).toBe("OKF v0.2");
    cleanup();
    card({ isOkf: true, okfVersion: null });
    expect(screen.getByTestId("okf-badge").textContent).toBe("OKF");
    cleanup();
    expect(card({ isOkf: false }).querySelector("[data-testid=okf-badge]")).toBeNull();
  });

  it("shows a placeholder for a missing or blank description", () => {
    expect(card({ description: null }).textContent).toContain("No description");
    cleanup();
    expect(card({ description: "   " }).textContent).toContain("No description");
  });

  it("clamps a long description and renders markup in it as text", () => {
    const el = card({ description: `<img src=x onerror=alert(1)> ${"long ".repeat(200)}` });
    expect(el.querySelector("img")).toBeNull();
    const p = screen.getByText(/onerror/);
    expect(p.className).toContain("line-clamp-3");
    expect(p.className).toContain("break-words");
  });

  it("shows the sync error and still links to previously stored content", () => {
    const el = card({
      syncStatus: "error",
      syncError: "GitHub rate limit exhausted; retry later",
    });
    const box = within(el).getByTestId("repo-sync-error");
    expect(box.textContent).toContain("Last sync failed");
    expect(box.textContent).toContain("GitHub rate limit exhausted; retry later");
    expect(box.textContent).toContain("Showing previously synced content.");
    expect(within(el).getByRole("link", { name: "acme/api-service" })).toBeTruthy();
    expect(el.textContent).toContain("12 documents");
    expect(el.querySelector("time")).not.toBeNull();
  });

  it("says no content is stored when a repository failed its first sync", () => {
    const el = card({
      syncStatus: "error",
      syncError: "not found on GitHub",
      lastSyncedAt: null,
      docCount: 0,
    });
    expect(within(el).getByTestId("repo-sync-error").textContent).toContain(
      "No content has been stored yet.",
    );
  });

  it("shows the pending state for a repository that has never synced", () => {
    const el = card({ syncStatus: "pending", lastSyncedAt: null, docCount: 0 });
    expect(within(el).getByTestId("repo-pending").textContent).toContain(
      "Waiting for the first sync",
    );
    expect(el.textContent).toContain("Not synced yet");
    expect(el.textContent).toContain("No documents");
    expect(el.querySelector("time")).toBeNull();
    expect(within(el).getByRole("link", { name: "acme/api-service" })).toBeTruthy();
  });

  it("shows neither error nor pending box for a healthy repository", () => {
    const el = card();
    expect(el.querySelector("[data-testid=repo-sync-error]")).toBeNull();
    expect(el.querySelector("[data-testid=repo-pending]")).toBeNull();
  });
});

describe("labels", () => {
  it("formats the OKF badge", () => {
    expect(okfBadgeLabel(null)).toBe("OKF");
    expect(okfBadgeLabel("  ")).toBe("OKF");
    expect(okfBadgeLabel("0.2")).toBe("OKF v0.2");
    expect(okfBadgeLabel("v0.2")).toBe("OKF v0.2");
  });

  it("formats the document count", () => {
    expect(documentCountLabel(0)).toBe("No documents");
    expect(documentCountLabel(1)).toBe("1 document");
    expect(documentCountLabel(2)).toBe("2 documents");
  });
});
