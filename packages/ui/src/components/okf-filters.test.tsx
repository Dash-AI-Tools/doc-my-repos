// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildTocFilterView,
  parseTocFilters,
  type TocFacetCounts,
  type TocFilterView,
} from "@docmyrepos/core/internal/toc-filters";

import { documentsMatchLabel, OkfFilters } from "./okf-filters";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const FACETS: TocFacetCounts = {
  types: [
    { value: "Concept", count: 3 },
    { value: "Runbook", count: 1 },
    { value: "concept", count: 1 },
  ],
  tags: [
    { value: "finance", count: 4 },
    { value: "core", count: 2 },
  ],
  statuses: [{ value: "active", count: 3 }],
};

function view(
  query: Record<string, string | string[]> = {},
  facets: TocFacetCounts = FACETS,
  counts = { matches: 5, total: 5 },
): TocFilterView {
  const result = buildTocFilterView({
    basePath: "/acme/kb",
    state: parseTocFilters(query),
    facets,
    counts,
  });
  if (result === null) throw new Error("no view");
  return result;
}

function chips(group: string): HTMLElement[] {
  return within(screen.getByTestId(`okf-filter-${group}`)).getAllByTestId("okf-filter-chip");
}

describe("OkfFilters", () => {
  it("shows Type, Tag and Status groups with chip labels and counts", () => {
    render(<OkfFilters view={view()} />);
    const root = screen.getByRole("group", { name: "Filter documents" });
    expect(within(root).getByRole("group", { name: "Type" })).toBeTruthy();
    expect(within(root).getByRole("group", { name: "Tag" })).toBeTruthy();
    expect(within(root).getByRole("group", { name: "Status" })).toBeTruthy();
    expect(chips("type").map((c) => c.textContent)).toEqual([
      "Concept 3 documents",
      "Runbook 1 document",
      "concept 1 document",
    ]);
    expect(
      chips("type").map(
        (c) => c.querySelector("[data-testid=okf-filter-count]")?.firstChild?.textContent,
      ),
    ).toEqual(["3", "1", "1"]);
  });

  it("lists types exactly as authored: Concept and concept are two separate chips", () => {
    render(<OkfFilters view={view()} />);
    const labels = chips("type").map((c) => c.firstElementChild?.textContent);
    expect(labels).toContain("Concept");
    expect(labels).toContain("concept");
  });

  it("never hardcodes a type: any free-form string is a chip", () => {
    render(
      <OkfFilters
        view={view(
          {},
          { types: [{ value: "Données (v2) <b>", count: 2 }], tags: [], statuses: [] },
        )}
      />,
    );
    expect(chips("type")[0]?.firstElementChild?.textContent).toBe("Données (v2) <b>");
    // Text, not markup.
    expect(chips("type")[0]?.querySelector("b")).toBeNull();
  });

  it("makes every chip a link to this page with that value toggled", () => {
    render(<OkfFilters view={view({ type: "Concept" })} />);
    const byName = Object.fromEntries(
      chips("type").map((c) => [c.firstElementChild?.textContent, c]),
    );
    // Selected: the link removes it. Not selected: the link adds it (OR within the kind).
    expect(byName.Concept?.getAttribute("href")).toBe("/acme/kb");
    expect(byName.Runbook?.getAttribute("href")).toBe("/acme/kb?type=Concept&type=Runbook");
    // A chip of another kind keeps the selection (AND across kinds).
    expect(chips("tag")[0]?.getAttribute("href")).toBe("/acme/kb?tag=finance&type=Concept");
  });

  it("announces the selected state in text and with aria-current, and styles it", () => {
    render(<OkfFilters view={view({ type: "Concept", tag: "core" })} />);
    const concept = chips("type")[0]!;
    expect(concept.getAttribute("aria-current")).toBe("true");
    expect(concept.getAttribute("data-selected")).toBe("true");
    expect(concept.textContent).toContain("selected, press to remove this filter");
    expect(concept.className).toContain("bg-primary");
    const other = chips("type")[1]!;
    expect(other.getAttribute("aria-current")).toBeNull();
    expect(other.textContent).not.toContain("selected");
    expect(other.className).not.toContain("bg-primary");
    expect(chips("tag").filter((c) => c.getAttribute("aria-current") === "true")).toHaveLength(1);
  });

  it("is operable by keyboard: every chip is a focusable link", () => {
    render(<OkfFilters view={view()} />);
    for (const chip of chips("type")) {
      expect(chip.tagName).toBe("A");
      expect(chip.getAttribute("tabindex")).toBeNull();
      chip.focus();
      expect(document.activeElement).toBe(chip);
    }
  });

  it("shows the summary and the clear link only while filtering", () => {
    const { rerender } = render(<OkfFilters view={view()} />);
    expect(screen.queryByTestId("okf-filter-summary")).toBeNull();
    expect(screen.queryByTestId("okf-filter-clear")).toBeNull();
    rerender(<OkfFilters view={view({ type: "Concept" }, FACETS, { matches: 3, total: 5 })} />);
    expect(screen.getByRole("status").textContent).toBe("3 of 5 documents match");
    expect(screen.getByTestId("okf-filter-clear").getAttribute("href")).toBe("/acme/kb");
  });

  it("leaves the clear link to the 'no documents match' message when nothing matches", () => {
    render(<OkfFilters view={view({ type: "Gone" }, FACETS, { matches: 0, total: 5 })} />);
    expect(screen.getByRole("status").textContent).toBe("0 of 5 documents match");
    expect(screen.queryByTestId("okf-filter-clear")).toBeNull();
  });

  it("lists a selected value that has no documents (count 0) so it can be removed", () => {
    render(<OkfFilters view={view({ type: "Gone" }, FACETS, { matches: 0, total: 5 })} />);
    const gone = chips("type").find((c) => c.firstElementChild?.textContent === "Gone");
    expect(gone?.getAttribute("aria-current")).toBe("true");
    expect(gone?.querySelector("[data-testid=okf-filter-count]")?.firstChild?.textContent).toBe(
      "0",
    );
    expect(gone?.getAttribute("href")).toBe("/acme/kb");
  });

  it("omits a group with no values", () => {
    render(<OkfFilters view={view({}, { types: FACETS.types, tags: [], statuses: [] })} />);
    expect(screen.queryByTestId("okf-filter-tag")).toBeNull();
    expect(screen.queryByTestId("okf-filter-status")).toBeNull();
    expect(screen.getByTestId("okf-filter-type")).toBeTruthy();
  });

  it("caps a long group behind a native 'Show more' details; selected chips stay visible", () => {
    const tags = Array.from({ length: 10 }, (_, i) => ({ value: `tag-${i}`, count: 10 - i }));
    render(<OkfFilters view={view({ tag: "tag-9" }, { ...FACETS, tags })} />);
    const group = screen.getByTestId("okf-filter-tag");
    const visible = within(group)
      .getAllByTestId("okf-filter-chip")
      .filter((c) => !c.closest("details"));
    expect(visible.map((c) => c.firstElementChild?.textContent)).toContain("tag-9");
    expect(visible).toHaveLength(6);
    const more = screen.getByTestId("okf-filter-more-tag");
    expect(more.tagName).toBe("DETAILS");
    expect(more.textContent).toContain("Show 4 more");
    expect(within(more).getAllByTestId("okf-filter-chip")).toHaveLength(4);
    // Short groups have no 'Show more'.
    expect(screen.queryByTestId("okf-filter-more-type")).toBeNull();
  });

  it("uses plain labels, not headings, so it cannot skip a heading level", () => {
    render(<OkfFilters view={view()} />);
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
  });
});

describe("documentsMatchLabel", () => {
  it("pluralizes by the total", () => {
    expect(documentsMatchLabel(0, 3)).toBe("0 of 3 documents match");
    expect(documentsMatchLabel(1, 1)).toBe("1 of 1 document match");
  });
});
