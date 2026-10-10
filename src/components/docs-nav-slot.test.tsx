// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { buildDocsTree, type DocsTreeRow } from "@/lib/docs-tree";

import { DocsNavSlot } from "./docs-nav-slot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

function row(path: string, title: string): DocsTreeRow {
  return { path, title, description: null, type: null, tags: [], status: null, reserved: null };
}

const tree = buildDocsTree(
  [row("docs/guides/setup.md", "Setup"), row("docs/guides/advanced/tuning.md", "Tuning")],
  "docs",
);
const empty = buildDocsTree([], null);

describe("DocsNavSlot, card (repository page)", () => {
  it("is the Documentation navigation landmark with its heading, count and tree", () => {
    render(<DocsNavSlot docCount={2} tree={tree} owner="acme" repo="api" />);
    const nav = screen.getByRole("navigation", { name: "Documentation" });
    expect(nav.getAttribute("data-testid")).toBe("docs-nav");
    const heading = within(nav).getByRole("heading", { level: 2, name: "Documentation" });
    expect(heading.id).toBe("docs-nav-heading");
    expect(within(nav).getByTestId("docs-nav-count").textContent).toBe("2 documents");
    expect(within(nav).getByRole("link", { name: "Setup" })).toBeTruthy();
  });

  it("handles one document", () => {
    const one = buildDocsTree([row("docs/a.md", "A")], "docs");
    render(<DocsNavSlot docCount={1} tree={one} owner="acme" repo="api" />);
    expect(screen.getByTestId("docs-nav-count").textContent).toBe("1 document");
  });

  it("says 'No documentation files found', with a hint, for a synced repository without docs", () => {
    render(<DocsNavSlot docCount={0} tree={empty} owner="acme" repo="api" />);
    const box = screen.getByTestId("docs-nav-empty");
    expect(box.textContent).toContain("No documentation files found");
    expect(box.textContent).toContain("docs/");
    expect(screen.queryByTestId("docs-nav-pending")).toBeNull();
    expect(screen.queryByTestId("docs-tree")).toBeNull();
  });

  it("says the table of contents appears after the first sync for a repository never synced", () => {
    render(<DocsNavSlot docCount={0} tree={empty} owner="acme" repo="api" awaitingSync />);
    expect(screen.getByTestId("docs-nav-pending").textContent).toContain("after the first sync");
    expect(screen.queryByTestId("docs-nav-empty")).toBeNull();
    expect(screen.queryByText("No documentation files found")).toBeNull();
  });

  it("limits the height of a long tree inside the card", () => {
    render(<DocsNavSlot docCount={2} tree={tree} owner="acme" repo="api" />);
    expect(screen.getByTestId("docs-tree").className).toContain("overflow-y-auto");
  });
});

describe("DocsNavSlot, sidebar (document page)", () => {
  it("keeps the landmark, collapses on small screens and marks the current page", () => {
    render(
      <DocsNavSlot
        variant="sidebar"
        docCount={2}
        tree={tree}
        owner="acme"
        repo="api"
        currentPath="docs/guides/setup.md"
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Documentation" });
    // the summary is the label; there is no heading of its own and no count
    expect(within(nav).queryByRole("heading")).toBeNull();
    expect(within(nav).queryByTestId("docs-nav-count")).toBeNull();
    expect(nav.querySelector(":scope > details > summary")?.textContent).toBe("Documentation");
    expect(within(nav).getByRole("link", { name: "Setup" }).getAttribute("aria-current")).toBe(
      "page",
    );
    // the sidebar scrolls as a whole: the tree has no height limit of its own
    expect(screen.getByTestId("docs-tree").className).not.toContain("overflow-y-auto");
  });
});
