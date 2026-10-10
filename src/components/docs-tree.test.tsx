// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { buildDocsTree, toNavTree, type DocsTreeRow, type NavFolder } from "@/lib/docs-tree";
import { docUrl } from "@/lib/routes";

import { ancestorPaths, DocsTree, initialOpen, OPEN_ALL_UP_TO } from "./docs-tree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

function row(path: string, title: string, extra: Partial<DocsTreeRow> = {}): DocsTreeRow {
  const lower = (path.split("/").pop() ?? "").toLowerCase();
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

function nav(rows: DocsTreeRow[], owner = "acme", repo = "api"): NavFolder {
  const tree = buildDocsTree(rows, "docs");
  return toNavTree(tree, (doc) => docUrl(owner, repo, doc.path, tree.path));
}

const NESTED = nav([
  row("docs/guides/setup.md", "Setup"),
  row("docs/guides/advanced/tuning.md", "Tuning"),
]);

function show(tree = NESTED, currentPath: string | null = null) {
  return render(<DocsTree tree={tree} currentPath={currentPath} />);
}

/** The disclosure button of the folder called `name`. */
function toggle(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

function listOf(button: HTMLElement): HTMLElement {
  const list = document.getElementById(button.getAttribute("aria-controls") ?? "");
  if (list === null) throw new Error("no list");
  return list;
}

/** The entries of a list: documents by title, folders as `name/`. */
function entries(list: Element): string[] {
  return [...list.children].map((li) => {
    const button = li.querySelector(":scope > button, :scope > div > button");
    if (button !== null) return `${button.textContent}/`;
    return li.textContent ?? "";
  });
}

describe("DocsTree, spec scenario 'Nested folders'", () => {
  it("shows a guides folder with Setup and a nested advanced folder with Tuning", () => {
    show();
    const guides = listOf(toggle("guides"));
    expect(within(guides).getByRole("link", { name: "Setup" })).toBeTruthy();
    const advanced = toggle("advanced");
    expect(guides.contains(advanced)).toBe(true);
    expect(
      within(listOf(advanced)).getByRole("link", { name: "Tuning", hidden: true }),
    ).toBeTruthy();
    // Tuning is not a direct child of guides
    expect(entries(guides)).toEqual(["Setup", "advanced/"]);
  });

  it("links each entry to its document page", () => {
    show();
    const setup = screen.getByRole("link", { name: "Setup", hidden: true });
    expect(setup.getAttribute("href")).toBe("/acme/api/docs/guides/setup");
    expect(screen.getByRole("link", { name: "Tuning", hidden: true }).getAttribute("href")).toBe(
      "/acme/api/docs/guides/advanced/tuning",
    );
  });

  it("opens the top-level folders of a small repository and closes the nested ones", () => {
    show();
    expect(toggle("guides").getAttribute("aria-expanded")).toBe("true");
    expect(listOf(toggle("guides")).hidden).toBe(false);
    expect(toggle("advanced").getAttribute("aria-expanded")).toBe("false");
    expect(listOf(toggle("advanced")).hidden).toBe(true);
    // a collapsed folder's links are out of the accessibility tree
    expect(screen.queryByRole("link", { name: "Tuning" })).toBeNull();
  });
});

describe("DocsTree, open and close", () => {
  it("toggles one folder with its button", () => {
    show();
    fireEvent.click(toggle("advanced"));
    expect(toggle("advanced").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Tuning" })).toBeTruthy();
    fireEvent.click(toggle("guides"));
    expect(toggle("guides").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Setup" })).toBeNull();
    fireEvent.click(toggle("guides"));
    expect(screen.getByRole("link", { name: "Setup" })).toBeTruthy();
  });

  it("expands and collapses everything", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("has no controls for a tree without folders", () => {
    show(nav([row("docs/a.md", "A")]));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the open folders on the server, so the page does not jump when it hydrates", () => {
    const html = renderToStaticMarkup(
      <DocsTree tree={NESTED} currentPath="docs/guides/advanced/tuning.md" />,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const lists = [...doc.querySelectorAll("ul[id]")];
    expect(lists.map((l) => l.hasAttribute("hidden"))).toEqual([false, false]);
    expect(doc.querySelector('[aria-current="page"]')?.textContent).toBe("Tuning");
  });
});

describe("DocsTree, spec scenario 'Folder index'", () => {
  const tree = nav([
    row("docs/guides/index.md", "Guides overview", { description: "How-to guides for operators." }),
    row("docs/guides/setup.md", "Setup"),
    row("docs/reference/endpoints.md", "Endpoints"),
  ]);

  it("links the folder entry to its index.md and shows the index description", () => {
    show(tree);
    const link = screen.getByRole("link", { name: "guides" });
    expect(link.getAttribute("href")).toBe("/acme/api/docs/guides/index");
    expect(screen.getByTestId("folder-summary").textContent).toBe("How-to guides for operators.");
    // the link is next to the folder's toggle, never inside a button
    expect(link.closest("button")).toBeNull();
    expect(toggle("guides").getAttribute("aria-expanded")).toBe("true");
  });

  it("does not repeat the index as a child, and a folder without one has no link or summary", () => {
    show(tree);
    expect(screen.queryByRole("link", { name: "Guides overview" })).toBeNull();
    expect(screen.queryByRole("link", { name: "reference" })).toBeNull();
    expect(screen.getAllByTestId("folder-summary")).toHaveLength(1);
    expect(entries(listOf(toggle("guides")))).toEqual(["Setup"]);
  });

  it("lists the docs root index first", () => {
    show(nav([row("docs/index.md", "Home"), row("docs/a.md", "Alpha")]));
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual(["Home", "Alpha"]);
  });

  it("marks a folder's link as current when its index is the page, and opens the folder", () => {
    show(tree, "docs/guides/index.md");
    expect(screen.getByRole("link", { name: "guides" }).getAttribute("aria-current")).toBe("page");
    expect(toggle("guides").getAttribute("aria-expanded")).toBe("true");
  });
});

describe("DocsTree, order", () => {
  it("lists documents by title, then folders by name, with log.md last", () => {
    show(
      nav([
        row("docs/zeta.md", "Zeta"),
        row("docs/alpha.md", "Alpha"),
        row("docs/log.md", "Change log"),
        row("docs/b-folder/x.md", "X"),
        row("docs/a-folder/y.md", "Y"),
      ]),
    );
    const top = screen.getByTestId("docs-tree").querySelector(":scope > ul") as HTMLElement;
    expect(entries(top)).toEqual(["Alpha", "Zeta", "Change log", "a-folder/", "b-folder/"]);
  });
});

describe("DocsTree, current page", () => {
  it("marks the current document aria-current=page and opens its ancestors", () => {
    show(NESTED, "docs/guides/advanced/tuning.md");
    const current = document.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe("Tuning");
    expect(toggle("guides").getAttribute("aria-expanded")).toBe("true");
    expect(toggle("advanced").getAttribute("aria-expanded")).toBe("true");
  });

  it("opens only the ancestors of the current page in a large repository", () => {
    const rows = Array.from({ length: OPEN_ALL_UP_TO + 5 }, (_, i) =>
      row(`docs/f${i % 4}/d${i}.md`, `Doc ${i}`),
    );
    show(nav(rows), "docs/f2/d2.md");
    const open = screen.getAllByRole("button", { expanded: true }).map((b) => b.textContent);
    expect(open).toEqual(["f2"]);
  });

  it("opens the folders of a new current page and keeps what the visitor opened", () => {
    const rows = [
      ...Array.from({ length: OPEN_ALL_UP_TO + 5 }, (_, i) =>
        row(`docs/f${i % 4}/d${i}.md`, `D${i}`),
      ),
    ];
    const tree = nav(rows);
    const { rerender } = render(<DocsTree tree={tree} currentPath="docs/f0/d0.md" />);
    fireEvent.click(toggle("f3"));
    rerender(<DocsTree tree={tree} currentPath="docs/f1/d1.md" />);
    const open = screen
      .getAllByRole("button", { expanded: true })
      .map((b) => b.textContent)
      .sort();
    expect(open).toEqual(["f0", "f1", "f3"]);
    expect(document.querySelector('[aria-current="page"]')?.textContent).toBe("D1");
  });

  it("finds ancestors by folder, not by name prefix", () => {
    const tree = nav([row("docs/guide/a.md", "A"), row("docs/guides/b.md", "B")]);
    expect(ancestorPaths(tree, "docs/guides/b.md")).toEqual(["docs/guides"]);
    expect(ancestorPaths(tree, null)).toEqual([]);
    expect([...initialOpen(tree, null)].sort()).toEqual(["docs/guide", "docs/guides"]);
  });
});

describe("DocsTree, untrusted text and encoding", () => {
  it("escapes titles and folder names and encodes link segments", () => {
    show(nav([row("docs/a b/<img src=x onerror=alert(1)>.md", "<script>alert(1)</script>")]), null);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    const link = screen.getByRole("link");
    expect(link.textContent).toBe("<script>alert(1)</script>");
    expect(link.getAttribute("href")).toBe(
      "/acme/api/docs/a%20b/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E",
    );
    expect(toggle("a b")).toBeTruthy();
  });
});

describe("DocsTree, many documents", () => {
  it("renders 2000 documents in 100 folders and toggles a folder quickly", () => {
    const rows = Array.from({ length: 2000 }, (_, i) =>
      row(`docs/section-${String(i % 100).padStart(3, "0")}/page-${i}.md`, `Page ${i}`),
    );
    const tree = nav(rows);
    const started = performance.now();
    show(tree);
    const rendered = performance.now() - started;
    expect(document.querySelectorAll("a")).toHaveLength(2000);
    // large repository: everything starts closed
    expect(screen.queryAllByRole("button", { expanded: true })).toHaveLength(0);
    const clicked = performance.now();
    fireEvent.click(toggle("section-007"));
    const toggled = performance.now() - clicked;
    expect(screen.getAllByRole("link")).toHaveLength(20);
    // generous bounds: regression guards against quadratic work, not benchmarks
    expect(rendered).toBeLessThan(5000);
    expect(toggled).toBeLessThan(2000);
  });
});
