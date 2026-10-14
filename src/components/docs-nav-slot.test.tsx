// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { buildDocsTree, type DocsTreeRow } from "@/lib/docs-tree";
import {
  buildTocFilterView,
  countTocRows,
  filterDocsRows,
  parseTocFilters,
  type TocFilterView,
} from "@/lib/toc-filters";

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

describe("DocsNavSlot, states and count", () => {
  it("is the Documentation navigation landmark with its label, count and tree", () => {
    render(<DocsNavSlot docCount={2} tree={tree} owner="acme" repo="api" showCount />);
    const nav = screen.getByRole("navigation", { name: "Documentation" });
    expect(nav.getAttribute("data-testid")).toBe("docs-nav");
    expect(within(nav).getByText("Documentation").tagName).toBe("P");
    expect(within(nav).getByTestId("docs-nav-count").textContent).toBe("2 documents");
    expect(within(nav).getByRole("link", { name: "Setup" })).toBeTruthy();
  });

  it("handles one document", () => {
    const one = buildDocsTree([row("docs/a.md", "A")], "docs");
    render(<DocsNavSlot docCount={1} tree={one} owner="acme" repo="api" showCount />);
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

  it("shows no count unless asked, and leaves scrolling to the column or panel", () => {
    render(<DocsNavSlot docCount={2} tree={tree} owner="acme" repo="api" />);
    expect(screen.queryByTestId("docs-nav-count")).toBeNull();
    expect(screen.getByTestId("docs-tree").className).not.toContain("overflow-y-auto");
  });
});

describe("DocsNavSlot, as the document page column", () => {
  it("keeps the landmark, labels it without a heading and marks the current page", () => {
    render(
      <DocsNavSlot
        docCount={2}
        tree={tree}
        owner="acme"
        repo="api"
        currentPath="docs/guides/setup.md"
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Documentation" });
    // a plain label, not a heading, and no count; no disclosure (the panel owns open and close)
    expect(within(nav).queryByRole("heading")).toBeNull();
    expect(within(nav).queryByTestId("docs-nav-count")).toBeNull();
    expect(within(nav).getByText("Documentation").tagName).toBe("P");
    expect(nav.querySelector("details")).toBeNull();
    expect(within(nav).getByRole("link", { name: "Setup" }).getAttribute("aria-current")).toBe(
      "page",
    );
    // the sidebar scrolls as a whole: the tree has no height limit of its own
    expect(screen.getByTestId("docs-tree").className).not.toContain("overflow-y-auto");
  });
});

describe("DocsNavSlot, OKF filters (tasks 11.1 to 11.3)", () => {
  const typed = (path: string, title: string, over: Partial<DocsTreeRow>): DocsTreeRow => ({
    ...row(path, title),
    ...over,
  });
  const rows: DocsTreeRow[] = [
    typed("docs/guides/setup.md", "Setup", { type: "Concept", tags: ["core"], status: "active" }),
    typed("docs/guides/advanced/tuning.md", "Tuning", { type: "Table", status: "draft" }),
    typed("docs/ref.md", "Ref", { type: "Concept" }),
  ];
  const facets = {
    types: [
      { value: "Concept", count: 2 },
      { value: "Table", count: 1 },
    ],
    tags: [{ value: "core", count: 1 }],
    statuses: [
      { value: "active", count: 1 },
      { value: "draft", count: 1 },
    ],
  };

  function props(query: Record<string, string | string[]>, keep: string | null = null) {
    const state = parseTocFilters(query);
    return {
      docCount: 3,
      owner: "acme",
      repo: "kb",
      tree: buildDocsTree(filterDocsRows(rows, state, keep), "docs"),
      filters: buildTocFilterView({
        basePath: "/acme/kb",
        state,
        facets,
        counts: countTocRows(rows, state),
      }) as TocFilterView,
    };
  }

  it("renders the filters above the tree, inside the Documentation landmark", () => {
    render(<DocsNavSlot {...props({})} />);
    const nav = screen.getByRole("navigation", { name: "Documentation" });
    const filters = within(nav).getByTestId("okf-filters");
    const tree = within(nav).getByTestId("docs-tree");
    expect(filters.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Unfiltered: the whole tree, plain links.
    expect(within(nav).getByRole("link", { name: "Ref" }).getAttribute("href")).toBe(
      "/acme/kb/docs/ref",
    );
  });

  it("renders no OKF UI without a filters view (a plain repository)", () => {
    render(<DocsNavSlot docCount={3} tree={buildDocsTree(rows, "docs")} owner="acme" repo="kb" />);
    expect(screen.queryByTestId("okf-filters")).toBeNull();
    expect(screen.queryByText(/filter/i)).toBeNull();
    expect(screen.queryByText(/OKF/)).toBeNull();
    render(
      <DocsNavSlot
        docCount={3}
        tree={buildDocsTree(rows, "docs")}
        owner="acme"
        repo="kb"
        filters={null}
      />,
    );
    expect(screen.queryByTestId("okf-filters")).toBeNull();
  });

  it("narrows the tree, hides folders with no match, and opens the rest", () => {
    render(<DocsNavSlot {...props({ type: "Table" })} />);
    const tree = screen.getByTestId("docs-tree");
    expect(within(tree).getByRole("link", { name: "Tuning" })).toBeTruthy();
    expect(within(tree).queryByRole("link", { name: "Setup" })).toBeNull();
    expect(within(tree).queryByRole("link", { name: "Ref" })).toBeNull();
    // `guides` and `advanced` hold the match: open, so it is visible, not hidden in a closed folder.
    for (const name of ["guides", "advanced"]) {
      expect(within(tree).getByRole("button", { name }).getAttribute("aria-expanded")).toBe("true");
    }
    expect(screen.getByRole("status").textContent).toBe("1 of 3 documents match");
  });

  it("carries the filters in every document link", () => {
    render(<DocsNavSlot {...props({ type: "Concept", status: "active" })} />);
    expect(screen.getByRole("link", { name: "Setup" }).getAttribute("href")).toBe(
      "/acme/kb/docs/guides/setup?status=active&type=Concept",
    );
  });

  it("says no document matches, with a clear link, instead of the 'no files' state", () => {
    render(<DocsNavSlot {...props({ type: "Nope" })} />);
    const box = screen.getByTestId("docs-nav-no-match");
    expect(box.textContent).toContain("No documents match these filters");
    expect(within(box).getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe(
      "/acme/kb",
    );
    expect(screen.queryByTestId("docs-nav-empty")).toBeNull();
    expect(screen.queryByTestId("docs-tree")).toBeNull();
    // The selected value stays listed so it can be removed.
    const type = screen.getByTestId("okf-filter-type");
    const nope = within(type).getByRole("link", { name: /Nope/ });
    expect(nope.getAttribute("aria-current")).toBe("true");
  });

  it("keeps the page being read in the sidebar even when it does not match", () => {
    render(<DocsNavSlot {...props({ type: "Table" }, "docs/ref.md")} currentPath="docs/ref.md" />);
    const current = screen.getByRole("link", { name: "Ref" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Tuning" })).toBeTruthy();
    expect(screen.queryByTestId("docs-nav-no-match")).toBeNull();
  });

  it("still shows the page being read next to the no-match message", () => {
    render(<DocsNavSlot {...props({ type: "Nope" }, "docs/ref.md")} currentPath="docs/ref.md" />);
    expect(screen.getByTestId("docs-nav-no-match")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ref" }).getAttribute("aria-current")).toBe("page");
  });

  it("resets the open folders when the filter changes", () => {
    const { rerender } = render(<DocsNavSlot {...props({ type: "Table" })} />);
    fireEvent.click(screen.getByRole("button", { name: "advanced" }));
    expect(screen.getByRole("button", { name: "advanced" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    // A different filter is a different tree: folders start open again.
    rerender(<DocsNavSlot {...props({ type: "Table", status: "draft" })} />);
    expect(screen.getByRole("button", { name: "advanced" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });
});

describe("DocsNavSlot, change log label (task 11.6)", () => {
  const rows: DocsTreeRow[] = [
    row("docs/a.md", "A"),
    { ...row("docs/log.md", "Log"), reserved: "log" },
    { ...row("docs/index.md", "Home"), reserved: "index" },
  ];
  const withLog = buildDocsTree(rows, "docs");

  it("labels log.md as a change log in an OKF repository, and nothing else", () => {
    render(<DocsNavSlot docCount={3} tree={withLog} owner="acme" repo="kb" okf />);
    expect(screen.getAllByTestId("docs-tree-label").map((el) => el.textContent)).toEqual([
      "Change log",
    ]);
  });

  it("shows no label in a plain repository", () => {
    render(<DocsNavSlot docCount={3} tree={withLog} owner="acme" repo="kb" />);
    expect(screen.queryByTestId("docs-tree-label")).toBeNull();
  });
});
