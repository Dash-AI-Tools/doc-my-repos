// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildDocsTree, buildPathTree, type DocsTreeRow } from "@/lib/docs-tree";
import {
  buildTocFilterView,
  countTocRows,
  filterDocsRows,
  parseTocFilters,
  type TocFilterView,
} from "@/lib/toc-filters";

// The selector posts to a server action; these tests only render it.
vi.mock("@/server/nav-view-action", () => ({ setNavView: async () => {} }));
// Recorded, not run: jsdom has no layout. The view tests check what the tree asks to reveal.
const reveal = vi.hoisted(() => vi.fn<(el: HTMLElement) => void>());
vi.mock("./reveal-in-scroller", () => ({ revealInScroller: reveal }));

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

describe("DocsNavSlot, navigation views (docs-nav-views)", () => {
  const rows: DocsTreeRow[] = [
    { ...row("docs/log.md", "Changes"), reserved: "log" },
    { ...row("docs/index.md", "Home"), reserved: "index" },
    { ...row("docs/guides/setup.md", "Getting started"), type: "Concept" },
    row("docs/guides/advanced/tuning.md", "Tuning"),
  ];
  const okfTree = buildDocsTree(rows, "docs");
  const pathTree = buildPathTree(rows, "docs");
  const filters = buildTocFilterView({
    basePath: "/acme/kb",
    state: parseTocFilters({}),
    facets: { types: [{ value: "Concept", count: 1 }], tags: [], statuses: [] },
    counts: { matches: 1, total: 1 },
  }) as TocFilterView;

  function nav() {
    return screen.getByRole("navigation", { name: "Documentation" });
  }

  it("shows no selector for a repository that is not OKF", () => {
    render(<DocsNavSlot docCount={4} tree={okfTree} owner="acme" repo="kb" showCount />);
    expect(screen.queryByTestId("nav-view-selector")).toBeNull();
    expect(screen.queryByRole("group", { name: "Navigation view" })).toBeNull();
  });

  it("puts the selector first in the landmark, above the label, the filters and the tree", () => {
    render(
      <DocsNavSlot
        docCount={4}
        tree={okfTree}
        owner="acme"
        repo="kb"
        okf
        view="okf"
        filters={filters}
        showCount
      />,
    );
    const first = nav().firstElementChild;
    expect(first?.getAttribute("data-testid")).toBe("nav-view-selector");
    expect(first?.nextElementSibling?.textContent).toBe("Documentation");
    expect(within(nav()).getByRole("button", { name: "OKF" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    // OKF view unchanged: titles, filters, change log label.
    expect(within(nav()).getByRole("link", { name: "Getting started" })).toBeTruthy();
    expect(within(nav()).getByTestId("okf-filters")).toBeTruthy();
    // A Hairline rule separates the filters from the structure.
    const section = within(nav()).getByTestId("okf-filters-section");
    expect(section.className).toContain("border-b");
    expect(section.className).toContain("border-border");
    expect(section.contains(within(nav()).getByTestId("okf-filters"))).toBe(true);
    expect(section.contains(screen.getByTestId("docs-tree"))).toBe(false);
    expect(screen.getAllByTestId("docs-tree-label").map((el) => el.textContent)).toEqual([
      "Change log",
    ]);
  });

  it("Tree: file names in path order, no filters, no labels, current page marked", () => {
    render(
      <DocsNavSlot
        docCount={4}
        tree={pathTree}
        owner="acme"
        repo="kb"
        okf
        view="tree"
        currentPath="docs/guides/setup.md"
      />,
    );
    expect(within(nav()).getByRole("button", { name: "Tree" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    // Every entry, including those in the closed `advanced` folder.
    const links = Array.from(screen.getByTestId("docs-tree").querySelectorAll("a")).map(
      (a) => a.textContent,
    );
    expect(links).toEqual(["tuning", "setup", "index", "log"]);
    const setup = within(nav()).getByRole("link", { name: "setup" });
    expect(setup.getAttribute("href")).toBe("/acme/kb/docs/guides/setup");
    expect(setup.getAttribute("aria-current")).toBe("page");
    expect(within(nav()).queryByRole("link", { name: "Getting started" })).toBeNull();
    expect(screen.queryByTestId("okf-filters")).toBeNull();
    expect(screen.queryByTestId("okf-filters-section")).toBeNull();
    expect(screen.queryByTestId("docs-tree-label")).toBeNull();
  });

  it("reveals the current page again after the view changes (the tree is re-keyed)", () => {
    const props = { docCount: 4, owner: "acme", repo: "kb", okf: true } as const;
    const current = "docs/guides/setup.md";
    const { rerender } = render(
      <DocsNavSlot {...props} tree={okfTree} view="okf" currentPath={current} />,
    );
    expect(reveal.mock.lastCall?.[0].textContent).toBe("Getting started");
    reveal.mockClear();
    rerender(<DocsNavSlot {...props} tree={pathTree} view="tree" currentPath={current} />);
    expect(reveal).toHaveBeenCalledTimes(1);
    const el = reveal.mock.lastCall?.[0];
    expect(el?.getAttribute("aria-current")).toBe("page");
    expect(el?.textContent).toBe("setup");
    expect(el?.isConnected).toBe(true);
  });
});
