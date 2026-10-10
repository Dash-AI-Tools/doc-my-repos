// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DocsNavSlot } from "./docs-nav-slot";
import { RepoLoadError } from "./repo-load-error";
import { RepoNotFound } from "./repo-not-found";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

describe("RepoNotFound", () => {
  it("names the problem and links home", () => {
    render(<RepoNotFound />);
    expect(screen.getByRole("heading", { level: 1, name: "Repository not found" })).toBeTruthy();
    expect(
      within(screen.getByTestId("repo-not-found"))
        .getByRole("link", { name: "Back to the home page" })
        .getAttribute("href"),
    ).toBe("/");
  });
});

describe("RepoLoadError", () => {
  it("shows fixed text with a retry link to the same page", () => {
    render(<RepoLoadError href="/acme/api-service" />);
    const panel = screen.getByTestId("load-error");
    expect(within(panel).getByRole("link", { name: "Try again" }).getAttribute("href")).toBe(
      "/acme/api-service",
    );
    expect(within(panel).getByRole("link", { name: "Back to the home page" })).toBeTruthy();
    expect(panel.textContent).not.toMatch(/postgres|ECONN/i);
  });
});

describe("DocsNavSlot (placeholder replaced by task 9.6)", () => {
  it("is the Documentation navigation landmark with a heading and the document count", () => {
    render(<DocsNavSlot docCount={4} />);
    const nav = screen.getByRole("navigation", { name: "Documentation" });
    expect(within(nav).getByRole("heading", { level: 2, name: "Documentation" })).toBeTruthy();
    expect(within(nav).getByTestId("docs-nav-count").textContent).toBe("4 documents");
  });

  it("handles zero and one document", () => {
    render(<DocsNavSlot docCount={0} />);
    expect(screen.getByTestId("docs-nav-count").textContent).toBe("No documents");
    cleanup();
    render(<DocsNavSlot docCount={1} />);
    expect(screen.getByTestId("docs-nav-count").textContent).toBe("1 document");
  });
});
