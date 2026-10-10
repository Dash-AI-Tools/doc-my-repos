import { describe, expect, it } from "vitest";

import {
  adjacentInTree,
  ancestorFolders,
  buildDocsTree,
  compareTreeText,
  countFolders,
  flattenDocsTree,
  resolveDocRoute,
  toNavTree,
  type DocsTreeFolder,
  type DocsTreeNode,
  type DocsTreeRow,
} from "./docs-tree";

function row(path: string, title: string, extra: Partial<DocsTreeRow> = {}): DocsTreeRow {
  const name = path.split("/").pop() ?? "";
  const lower = name.toLowerCase();
  return {
    path,
    title,
    description: null,
    type: null,
    tags: [],
    status: null,
    reserved: lower === "index.md" ? "index" : lower === "log.md" ? "log" : null,
    ...extra,
  };
}

/** A compact picture of the tree: folders as `name/`, documents as titles. */
function outline(folder: DocsTreeFolder): unknown[] {
  return folder.children.map((child: DocsTreeNode) =>
    child.kind === "doc"
      ? child.title
      : {
          [`${child.name}/`]: outline(child),
          ...(child.index ? { index: child.index.title } : {}),
        },
  );
}

describe("buildDocsTree", () => {
  it("nests folders as in the spec example", () => {
    const tree = buildDocsTree(
      [row("docs/guides/setup.md", "Setup"), row("docs/guides/advanced/tuning.md", "Tuning")],
      "docs",
    );
    expect(outline(tree)).toEqual([{ "guides/": ["Setup", { "advanced/": ["Tuning"] }] }]);
    const guides = tree.children[0] as DocsTreeFolder;
    expect(guides).toMatchObject({ kind: "folder", name: "guides", path: "docs/guides" });
    const advanced = guides.children[1] as DocsTreeFolder;
    expect(advanced.children[0]).toMatchObject({
      kind: "doc",
      path: "docs/guides/advanced/tuning.md",
      stem: "guides/advanced/tuning",
      fileName: "tuning.md",
    });
  });

  it("orders by folder then title: documents by title, then subfolders by name", () => {
    const tree = buildDocsTree(
      [
        row("docs/z-first.md", "Alpha"),
        row("docs/a-last.md", "Zulu"),
        row("docs/beta/x.md", "X"),
        row("docs/Alpha/y.md", "Y"),
        row("docs/10-ten.md", "10 Ten"),
        row("docs/2-two.md", "2 Two"),
      ],
      "docs",
    );
    expect(outline(tree)).toEqual([
      "2 Two",
      "10 Ten",
      "Alpha",
      "Zulu",
      { "Alpha/": ["Y"] },
      { "beta/": ["X"] },
    ]);
  });

  it("uses a folder's index.md as its link and summary, and the root index for the root", () => {
    const tree = buildDocsTree(
      [
        row("docs/index.md", "Overview", { description: "All the docs" }),
        row("docs/guides/index.md", "Guides", { description: "How to do things" }),
        row("docs/guides/setup.md", "Setup"),
      ],
      "docs",
    );
    expect(tree.index?.path).toBe("docs/index.md");
    expect(tree.summary).toBe("All the docs");
    const guides = tree.children[0] as DocsTreeFolder;
    expect(guides.index).toMatchObject({ path: "docs/guides/index.md", stem: "guides/index" });
    expect(guides.summary).toBe("How to do things");
    expect(outline(guides)).toEqual(["Setup"]);
  });

  it("keeps a folder made only of an index, with an empty child list", () => {
    const tree = buildDocsTree([row("docs/empty/index.md", "Empty")], "docs");
    expect(tree.children).toEqual([
      expect.objectContaining({ kind: "folder", name: "empty", children: [] }),
    ]);
  });

  it("puts log.md after the folder's other documents and keeps it as a page", () => {
    const tree = buildDocsTree(
      [row("docs/log.md", "A changelog"), row("docs/zeta.md", "Zeta")],
      "docs",
    );
    expect(outline(tree)).toEqual(["Zeta", "A changelog"]);
    expect(tree.children[1]).toMatchObject({ reserved: "log" });
  });

  it("prefers the exact index.md spelling and lists another spelling as a page", () => {
    const tree = buildDocsTree(
      [row("docs/INDEX.md", "Shouty"), row("docs/index.md", "Quiet")],
      "docs",
    );
    expect(tree.index?.title).toBe("Quiet");
    expect(outline(tree)).toEqual(["Shouty"]);
  });

  it("drops rows outside the docs folder or without a page, and is empty with no folder", () => {
    const rows = [row("README.md", "Readme"), row("docs/a.txt", "Txt"), row("docs/ok.md", "Ok")];
    expect(outline(buildDocsTree(rows, "docs"))).toEqual(["Ok"]);
    expect(buildDocsTree(rows, null).children).toEqual([]);
    expect(buildDocsTree(rows, "").children).toEqual([]);
  });

  it("works with nested docs folders and other folder names", () => {
    const tree = buildDocsTree([row("site/documentation/a/b.md", "B")], "site/documentation");
    expect(tree.path).toBe("site/documentation");
    expect((tree.children[0] as DocsTreeFolder).path).toBe("site/documentation/a");
  });

  it("is independent of input order", () => {
    const rows = [
      row("docs/b.md", "B"),
      row("docs/a.md", "A"),
      row("docs/x/index.md", "X"),
      row("docs/x/c.md", "C"),
      row("docs/same1.md", "Same"),
      row("docs/same0.md", "Same"),
    ];
    const forward = flattenDocsTree(buildDocsTree(rows, "docs")).map((d) => d.path);
    const backward = flattenDocsTree(buildDocsTree([...rows].reverse(), "docs")).map((d) => d.path);
    expect(forward).toEqual(backward);
    expect(forward).toEqual([
      "docs/a.md",
      "docs/b.md",
      "docs/same0.md",
      "docs/same1.md",
      "docs/x/index.md",
      "docs/x/c.md",
    ]);
  });

  it("keeps type, tags and status for filtering", () => {
    const tree = buildDocsTree(
      [row("docs/m.md", "M", { type: "Metric", tags: ["finance"], status: "draft" })],
      "docs",
    );
    expect(tree.children[0]).toMatchObject({ type: "Metric", tags: ["finance"], status: "draft" });
  });
});

describe("flattenDocsTree and adjacentInTree", () => {
  const tree = buildDocsTree(
    [
      row("docs/index.md", "Home"),
      row("docs/intro.md", "Intro"),
      row("docs/guides/index.md", "Guides"),
      row("docs/guides/setup.md", "Setup"),
      row("docs/guides/advanced/tuning.md", "Tuning"),
      row("docs/reference/api.md", "API"),
    ],
    "docs",
  );

  it("walks in table-of-contents order", () => {
    expect(flattenDocsTree(tree).map((d) => d.title)).toEqual([
      "Home",
      "Intro",
      "Guides",
      "Setup",
      "Tuning",
      "API",
    ]);
  });

  it("finds neighbours, with null at the ends and for an unknown path", () => {
    expect(adjacentInTree(tree, "docs/guides/setup.md")).toMatchObject({
      previous: { title: "Guides" },
      next: { title: "Tuning" },
    });
    expect(adjacentInTree(tree, "docs/index.md")?.previous).toBeNull();
    expect(adjacentInTree(tree, "docs/reference/api.md")?.next).toBeNull();
    expect(adjacentInTree(tree, "docs/nope.md")).toBeNull();
  });
});

describe("compareTreeText", () => {
  it("is numeric and case-insensitive, then exact", () => {
    expect(["b", "10", "B", "2", "a"].sort(compareTreeText)).toEqual(["2", "10", "a", "B", "b"]);
  });
});

describe("ancestorFolders and countFolders", () => {
  const tree = buildDocsTree(
    [
      row("docs/guides/setup.md", "Setup"),
      row("docs/guides/advanced/tuning.md", "Tuning"),
      row("docs/guides/advanced/deep/x.md", "X"),
      row("docs/top.md", "Top"),
    ],
    "docs",
  );

  it("lists the folders above a document, outermost first", () => {
    expect(ancestorFolders(tree, "docs/guides/advanced/tuning.md").map((f) => f.name)).toEqual([
      "guides",
      "advanced",
    ]);
    expect(ancestorFolders(tree, "docs/guides/setup.md").map((f) => f.name)).toEqual(["guides"]);
    expect(ancestorFolders(tree, "docs/top.md")).toEqual([]);
    expect(ancestorFolders(tree, "docs/nope/x.md")).toEqual([]);
  });

  it("does not take a folder whose name only starts the same way", () => {
    const t = buildDocsTree([row("docs/guide/a.md", "A"), row("docs/guides/b.md", "B")], "docs");
    expect(ancestorFolders(t, "docs/guides/b.md").map((f) => f.name)).toEqual(["guides"]);
  });

  it("counts folders at every level", () => {
    expect(countFolders(tree)).toBe(3);
    expect(countFolders(buildDocsTree([], null))).toBe(0);
  });
});

describe("resolveDocRoute", () => {
  const tree = buildDocsTree(
    [
      row("docs/index.md", "Home"),
      row("docs/guides/index.md", "Guides"),
      row("docs/guides/Setup.md", "Setup"),
      row("docs/reference/api.md", "API"),
      row("docs/Dupe.md", "Dupe upper"),
      row("docs/dupe.md", "Dupe lower"),
    ],
    "docs",
  );

  it("finds a document whose address differs only in case", () => {
    expect(resolveDocRoute(tree, ["GUIDES", "setup"])?.path).toBe("docs/guides/Setup.md");
  });

  it("is deterministic when several documents match: lowest path by code point", () => {
    expect(resolveDocRoute(tree, ["DUPE"])?.path).toBe("docs/Dupe.md");
  });

  it("leads a folder address to the folder's index", () => {
    expect(resolveDocRoute(tree, ["guides"])?.path).toBe("docs/guides/index.md");
    expect(resolveDocRoute(tree, ["Guides"])?.path).toBe("docs/guides/index.md");
  });

  it("is null for a folder without an index, an unknown path and no segments", () => {
    expect(resolveDocRoute(tree, ["reference"])).toBeNull();
    expect(resolveDocRoute(tree, ["nope"])).toBeNull();
    expect(resolveDocRoute(tree, [])).toBeNull();
    expect(resolveDocRoute(buildDocsTree([], null), ["guides"])).toBeNull();
  });

  it("prefers a document to a folder of the same name", () => {
    const t = buildDocsTree(
      [row("docs/guides.md", "Guides page"), row("docs/guides/index.md", "Guides index")],
      "docs",
    );
    expect(resolveDocRoute(t, ["GUIDES"])?.path).toBe("docs/guides.md");
  });
});

describe("toNavTree", () => {
  const tree = buildDocsTree(
    [
      row("docs/index.md", "Home", { description: "Root summary." }),
      row("docs/guides/index.md", "Guides", { description: "How-to guides." }),
      row("docs/guides/setup.md", "Setup"),
      row("docs/guides/advanced/tuning.md", "Tuning"),
      row("docs/odd/x.md", "X"),
    ],
    "docs",
  );
  const href = (doc: { stem: string }) => `/u/${doc.stem}`;

  it("keeps the order, links every page and turns an index into the folder's link", () => {
    const nav = toNavTree(tree, href);
    expect(nav.children.map((c) => (c.kind === "doc" ? c.title : `${c.name}/`))).toEqual([
      "Home",
      "guides/",
      "odd/",
    ]);
    const guides = nav.children[1];
    expect(guides).toMatchObject({
      kind: "folder",
      name: "guides",
      path: "docs/guides",
      href: "/u/guides/index",
      indexPath: "docs/guides/index.md",
      summary: "How-to guides.",
    });
    // the index is the folder's link, not a child
    expect(
      guides?.kind === "folder" && guides.children.map((c) => c.kind === "doc" && c.title),
    ).toEqual(["Setup", false]);
  });

  it("makes the root index a first child, without a summary on the root", () => {
    const nav = toNavTree(tree, href);
    expect(nav).toMatchObject({ name: "", href: null, indexPath: null, summary: null });
    expect(nav.children[0]).toEqual({
      kind: "doc",
      title: "Home",
      path: "docs/index.md",
      href: "/u/index",
    });
  });

  it("labels the pages labelFor names and leaves the others without a label key", () => {
    const withLog = buildDocsTree(
      [row("docs/a.md", "A"), row("docs/log.md", "Log", { reserved: "log" })],
      "docs",
    );
    const nav = toNavTree(withLog, href, (doc) => (doc.reserved === "log" ? "Change log" : null));
    expect(nav.children).toEqual([
      { kind: "doc", title: "A", path: "docs/a.md", href: "/u/a" },
      { kind: "doc", title: "Log", path: "docs/log.md", href: "/u/log", label: "Change log" },
    ]);
  });

  it("gives a folder without an index no link and no summary", () => {
    const odd = toNavTree(tree, href).children[2];
    expect(odd).toMatchObject({ kind: "folder", href: null, indexPath: null, summary: null });
  });

  it("drops a page that has no URL", () => {
    const nav = toNavTree(tree, (doc) => (doc.title === "Setup" ? null : href(doc)));
    const guides = nav.children[1];
    expect(guides?.kind === "folder" && guides.children.map((c) => c.kind)).toEqual(["folder"]);
  });

  it("is plain data: serializable for the browser", () => {
    const nav = toNavTree(tree, href);
    expect(JSON.parse(JSON.stringify(nav))).toEqual(nav);
  });
});
