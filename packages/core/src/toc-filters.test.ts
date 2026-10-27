import { describe, expect, it } from "vitest";

import { buildDocsTree, flattenDocsTree, type DocsTreeRow } from "./docs-tree";
import {
  buildTocFilterView,
  countTocRows,
  filterDocsRows,
  hasTocFilters,
  parseTocFilters,
  rowMatchesFilters,
  withFilterQuery,
} from "./toc-filters";

function row(path: string, over: Partial<DocsTreeRow> = {}): DocsTreeRow {
  return {
    path,
    title: path,
    description: null,
    type: null,
    tags: [],
    status: null,
    reserved: null,
    ...over,
  };
}

const rows: DocsTreeRow[] = [
  row("docs/index.md", { reserved: "index", type: "Concept", tags: ["finance"] }),
  row("docs/log.md", { reserved: "log", type: "Concept", status: "active" }),
  row("docs/a.md", { type: "Concept", tags: ["finance", "core"], status: "active" }),
  row("docs/b.md", { type: "Concept", tags: ["finance"], status: "draft" }),
  row("docs/c.md", { type: "concept", tags: ["core"], status: "active" }),
  row("docs/sub/d.md", { type: "Table", status: "deprecated" }),
  row("docs/sub/deep/e.md", { tags: ["finance"] }),
];

const paths = (list: readonly DocsTreeRow[]) => list.map((r) => r.path);

describe("parseTocFilters", () => {
  it("reads type, tag and status (repeatable), sorted, and nothing else", () => {
    const state = parseTocFilters(
      new URLSearchParams(
        "type=Table&type=Concept&tag=b&tag=a&status=draft&q=search&repo=acme/api&page=3&limit=5",
      ),
    );
    expect(state.types).toEqual(["Concept", "Table"]);
    expect(state.tags).toEqual(["a", "b"]);
    expect(state.statuses).toEqual(["draft"]);
    // Not part of the table of contents' state.
    expect(state.q).toBe("");
    expect(state.repos).toEqual([]);
    expect(state.page).toBe(1);
  });

  it("accepts what Next.js hands a page as searchParams", () => {
    const state = parseTocFilters({ type: ["Concept", "concept"], tag: "core", status: undefined });
    expect(state.types).toEqual(["Concept", "concept"]);
    expect(state.tags).toEqual(["core"]);
    expect(hasTocFilters(state)).toBe(true);
  });

  it("keeps values exactly as authored: case, spaces, unicode", () => {
    const state = parseTocFilters(
      new URLSearchParams([
        ["type", " Data Set "],
        ["type", "データ"],
      ]),
    );
    expect(state.types).toEqual([" Data Set ", "データ"].sort());
  });

  it("drops empty and hostile values instead of filtering by them", () => {
    const state = parseTocFilters(
      new URLSearchParams([
        ["type", ""],
        ["tag", "a\u0000b"],
        ["status", "x".repeat(1000)],
        ["type", "ok"],
      ]),
    );
    expect(state.types).toEqual(["ok"]);
    expect(state.tags).toEqual([]);
    expect(state.statuses).toEqual([]);
    expect(hasTocFilters(parseTocFilters({}))).toBe(false);
  });
});

describe("rowMatchesFilters and filterDocsRows", () => {
  it("keeps every row, reserved files included, when no filter is set", () => {
    expect(filterDocsRows(rows, parseTocFilters({}))).toHaveLength(rows.length);
  });

  it("never matches reserved files, even when they carry the value", () => {
    const state = parseTocFilters({ type: "Concept" });
    expect(paths(filterDocsRows(rows, state))).toEqual(["docs/a.md", "docs/b.md"]);
    expect(rowMatchesFilters(rows[0]!, parseTocFilters({ tag: "finance" }))).toBe(false);
  });

  it("matches types exactly: Concept and concept are different values", () => {
    expect(paths(filterDocsRows(rows, parseTocFilters({ type: "concept" })))).toEqual([
      "docs/c.md",
    ]);
    expect(paths(filterDocsRows(rows, parseTocFilters({ type: "CONCEPT" })))).toEqual([]);
  });

  it("ORs values of a kind", () => {
    const state = parseTocFilters({ type: ["Table", "concept"] });
    expect(paths(filterDocsRows(rows, state))).toEqual(["docs/c.md", "docs/sub/d.md"]);
    // A tag filter matches a document that has any of the tags.
    expect(paths(filterDocsRows(rows, parseTocFilters({ tag: ["core", "finance"] })))).toEqual([
      "docs/a.md",
      "docs/b.md",
      "docs/c.md",
      "docs/sub/deep/e.md",
    ]);
  });

  it("ANDs kinds", () => {
    const state = parseTocFilters({ type: "Concept", tag: "core", status: "active" });
    expect(paths(filterDocsRows(rows, state))).toEqual(["docs/a.md"]);
    expect(
      paths(filterDocsRows(rows, parseTocFilters({ type: "Concept", status: "draft" }))),
    ).toEqual(["docs/b.md"]);
  });

  it("never matches a document without the field being filtered", () => {
    expect(paths(filterDocsRows(rows, parseTocFilters({ type: "Table", tag: "finance" })))).toEqual(
      [],
    );
    expect(paths(filterDocsRows(rows, parseTocFilters({ status: "active" })))).toEqual([
      "docs/a.md",
      "docs/c.md",
    ]);
  });

  it("keeps the row at keepPath even when it does not match", () => {
    const state = parseTocFilters({ type: "Table" });
    expect(paths(filterDocsRows(rows, state, "docs/a.md"))).toEqual(["docs/a.md", "docs/sub/d.md"]);
    // ...and does nothing without a filter.
    expect(filterDocsRows(rows, parseTocFilters({}), "docs/a.md")).toHaveLength(rows.length);
  });

  it("does not mutate the rows", () => {
    const copy = JSON.stringify(rows);
    filterDocsRows(rows, parseTocFilters({ type: "Table" }));
    expect(JSON.stringify(rows)).toBe(copy);
  });

  it("gives a tree without the folders that have no matching document", () => {
    const filtered = buildDocsTree(
      filterDocsRows(rows, parseTocFilters({ type: "Table" })),
      "docs",
    );
    expect(flattenDocsTree(filtered).map((d) => d.path)).toEqual(["docs/sub/d.md"]);
    // `sub` stays (it holds the match), `deep` is gone.
    const folders = filtered.children.filter((c) => c.kind === "folder");
    expect(folders.map((f) => f.name)).toEqual(["sub"]);
    expect(folders[0]?.kind === "folder" && folders[0].children.map((c) => c.kind)).toEqual([
      "doc",
    ]);
    const none = buildDocsTree(filterDocsRows(rows, parseTocFilters({ type: "Nope" })), "docs");
    expect(none.children).toEqual([]);
  });
});

describe("countTocRows", () => {
  it("counts non-reserved documents as the total", () => {
    expect(countTocRows(rows, parseTocFilters({}))).toEqual({ matches: 5, total: 5 });
  });

  it("counts the matches", () => {
    expect(countTocRows(rows, parseTocFilters({ type: "Concept" }))).toEqual({
      matches: 2,
      total: 5,
    });
    expect(countTocRows(rows, parseTocFilters({ type: "Nope" }))).toEqual({
      matches: 0,
      total: 5,
    });
  });
});

describe("buildTocFilterView", () => {
  const facets = {
    types: [
      { value: "Concept", count: 3 },
      { value: "Table", count: 1 },
      { value: "concept", count: 1 },
    ],
    tags: [{ value: "finance", count: 4 }],
    statuses: [{ value: "active", count: 2 }],
  };
  const counts = { matches: 5, total: 5 };

  it("builds Type, Tag, Status groups in the order the counts arrive, with page-relative links", () => {
    const view = buildTocFilterView({
      basePath: "/acme/kb",
      state: parseTocFilters({}),
      facets,
      counts,
    });
    expect(view?.groups.map((g) => g.kind)).toEqual(["type", "tag", "status"]);
    expect(view?.groups[0]?.options.map((o) => [o.label, o.count, o.href])).toEqual([
      ["Concept", 3, "/acme/kb?type=Concept"],
      ["Table", 1, "/acme/kb?type=Table"],
      ["concept", 1, "/acme/kb?type=concept"],
    ]);
    expect(view?.active).toBe(false);
    expect(view?.clearHref).toBe("/acme/kb");
    expect(view?.query).toBe("");
  });

  it("toggles: selecting adds the value, selecting again removes it, other filters stay", () => {
    const view = buildTocFilterView({
      basePath: "/acme/kb/docs/x",
      state: parseTocFilters({ type: "Concept", tag: "finance" }),
      facets,
      counts: { matches: 2, total: 5 },
    });
    const type = view?.groups.find((g) => g.kind === "type");
    const byLabel = Object.fromEntries((type?.options ?? []).map((o) => [o.label, o]));
    expect(byLabel.Concept).toMatchObject({
      selected: true,
      href: "/acme/kb/docs/x?tag=finance",
    });
    expect(byLabel.Table).toMatchObject({
      selected: false,
      href: "/acme/kb/docs/x?tag=finance&type=Concept&type=Table",
    });
    expect(view?.active).toBe(true);
    expect(view?.query).toBe("tag=finance&type=Concept");
    // The selection keeps the facet order: it does not jump to the front.
    expect(type?.options.map((o) => o.label)).toEqual(["Concept", "Table", "concept"]);
  });

  it("lists a selected value that has no count, with count 0", () => {
    const view = buildTocFilterView({
      basePath: "/a/b",
      state: parseTocFilters({ type: "Gone" }),
      facets,
      counts: { matches: 0, total: 5 },
    });
    const gone = view?.groups[0]?.options.find((o) => o.label === "Gone");
    expect(gone).toMatchObject({ count: 0, selected: true, href: "/a/b" });
  });

  it("is null when there is nothing to filter by and nothing is selected", () => {
    expect(
      buildTocFilterView({
        basePath: "/a/b",
        state: parseTocFilters({}),
        facets: { types: [], tags: [], statuses: [] },
        counts: { matches: 3, total: 3 },
      }),
    ).toBeNull();
  });

  it("leaves a group out when it has no values (no tags in the repository)", () => {
    const view = buildTocFilterView({
      basePath: "/a/b",
      state: parseTocFilters({}),
      facets: { types: facets.types, tags: [], statuses: [] },
      counts,
    });
    expect(view?.groups.map((g) => g.kind)).toEqual(["type"]);
  });

  it("still shows the controls, to clear them, when a selection leaves no values", () => {
    const view = buildTocFilterView({
      basePath: "/a/b",
      state: parseTocFilters({ status: "x" }),
      facets: { types: [], tags: [], statuses: [] },
      counts: { matches: 0, total: 3 },
    });
    expect(view?.active).toBe(true);
    expect(view?.groups.map((g) => g.kind)).toEqual(["status"]);
  });

  it("percent-encodes hostile values in the links", () => {
    const view = buildTocFilterView({
      basePath: "/a/b",
      state: parseTocFilters({}),
      facets: {
        types: [{ value: 'A&b=c"<x>#y', count: 1 }],
        tags: [],
        statuses: [],
      },
      counts,
    });
    expect(view?.groups[0]?.options[0]?.href).toBe("/a/b?type=A%26b%3Dc%22%3Cx%3E%23y");
  });
});

describe("withFilterQuery", () => {
  it("appends the query, or leaves the href alone without one", () => {
    expect(withFilterQuery("/a/b/docs/x", "")).toBe("/a/b/docs/x");
    expect(withFilterQuery("/a/b/docs/x", "type=T")).toBe("/a/b/docs/x?type=T");
  });
});
