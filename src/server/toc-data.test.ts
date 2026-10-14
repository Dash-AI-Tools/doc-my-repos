import { afterAll, beforeAll, expect, it } from "vitest";

import { flattenDocsTree } from "@/lib/docs-tree";
import { parseTocFilters } from "@/lib/toc-filters";

import { loadDocPage } from "./doc-page";
import { documents, repos } from "./db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "./db/test-db";
import { loadRepoPage } from "./repo-page";

/**
 * The table of contents with the OKF filters applied (tasks 11.1 to 11.3), end to end through the
 * page loaders on a real database: OKF repositories are narrowed and counted, any other repository
 * ignores the filters and gets no OKF data at all.
 */

describeDb("OKF table of contents filters through the page loaders", () => {
  let t: TestDatabase;

  async function insertRepo(name: string, githubId: number, isOkf: boolean): Promise<number> {
    const [row] = await t.db
      .insert(repos)
      .values({
        githubId,
        owner: "acme",
        name,
        defaultBranch: "main",
        visibility: "public",
        htmlUrl: `https://github.com/acme/${name}`,
        docsPath: "docs",
        syncStatus: "ok",
        lastSyncedAt: new Date("2026-10-01T00:00:00Z"),
        isOkf,
        okfVersion: isOkf ? "0.2" : null,
      })
      .returning({ id: repos.id });
    if (row === undefined) throw new Error("insert failed");
    return row.id;
  }

  async function insertDoc(
    repoId: number,
    path: string,
    title: string,
    extra: Partial<typeof documents.$inferInsert> = {},
  ): Promise<void> {
    const name = (path.split("/").pop() ?? "").toLowerCase();
    await t.db.insert(documents).values({
      repoId,
      path,
      title,
      blobSha: `sha-${path}`,
      sizeBytes: 5,
      body: `# ${title}`,
      reserved: name === "index.md" ? "index" : name === "log.md" ? "log" : null,
      ...extra,
    });
  }

  async function seedDocs(repoId: number): Promise<void> {
    await insertDoc(repoId, "docs/index.md", "Overview", { type: "Index" });
    await insertDoc(repoId, "docs/log.md", "Changes");
    await insertDoc(repoId, "docs/a.md", "Alpha", {
      type: "Concept",
      tags: ["core"],
      status: "active",
    });
    await insertDoc(repoId, "docs/b.md", "Beta", { type: "concept", status: "draft" });
    await insertDoc(repoId, "docs/sub/c.md", "Gamma", { type: "Table", tags: ["core"] });
    await insertDoc(repoId, "docs/sub/d.md", "Delta");
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    await seedDocs(await insertRepo("kb", 1, true));
    // Not OKF as far as the sync decided, but its documents carry values (stale or odd data).
    await seedDocs(await insertRepo("plain", 2, false));
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  const deps = { db: () => t.db };
  const filters = (q: string) => parseTocFilters(new URLSearchParams(q));
  const paths = (tree: Parameters<typeof flattenDocsTree>[0]) =>
    flattenDocsTree(tree).map((d) => d.path);

  it("repository page: the whole tree and the counts when nothing is selected", async () => {
    const data = await loadRepoPage("acme", "kb", deps, filters(""));
    if (data.status !== "ok") throw new Error(data.status);
    expect(paths(data.tree)).toHaveLength(6);
    expect(data.toc?.counts).toEqual({ matches: 4, total: 4 });
    expect(data.toc?.facets.types).toEqual([
      { value: "Concept", count: 1 },
      { value: "Table", count: 1 },
      { value: "concept", count: 1 },
    ]);
    expect(data.toc?.facets.tags).toEqual([{ value: "core", count: 2 }]);
    expect(data.toc?.facets.statuses).toEqual([
      { value: "active", count: 1 },
      { value: "draft", count: 1 },
    ]);
  });

  it("repository page: narrows the tree (rows first, then folders) and counts disjunctively", async () => {
    const data = await loadRepoPage("acme", "kb", deps, filters("type=Table"));
    if (data.status !== "ok") throw new Error(data.status);
    expect(paths(data.tree)).toEqual(["docs/sub/c.md"]);
    expect(data.toc?.counts).toEqual({ matches: 1, total: 4 });
    // Types still list every type (the type filter is not applied to its own counts) ...
    expect(data.toc?.facets.types.map((x) => x.value)).toEqual(["Concept", "Table", "concept"]);
    // ... while tags are counted among the Table documents only.
    expect(data.toc?.facets.tags).toEqual([{ value: "core", count: 1 }]);
    expect(data.toc?.state.types).toEqual(["Table"]);
  });

  it("repository page: combined filters AND across kinds, OR within one", async () => {
    const a = await loadRepoPage("acme", "kb", deps, filters("type=Concept&tag=core"));
    const b = await loadRepoPage(
      "acme",
      "kb",
      deps,
      filters("type=Concept&type=concept&status=draft"),
    );
    if (a.status !== "ok" || b.status !== "ok") throw new Error("not ok");
    expect(paths(a.tree)).toEqual(["docs/a.md"]);
    expect(paths(b.tree)).toEqual(["docs/b.md"]);
  });

  it("repository page: a selection with no match gives an empty tree and zero matches", async () => {
    const data = await loadRepoPage("acme", "kb", deps, filters("type=Nope"));
    if (data.status !== "ok") throw new Error(data.status);
    expect(paths(data.tree)).toEqual([]);
    expect(data.toc?.counts).toEqual({ matches: 0, total: 4 });
  });

  it("repository page: a repository that is not OKF ignores the filters and has no OKF data", async () => {
    for (const q of ["", "type=Concept", "type=Nope&tag=zzz&status=draft"]) {
      const data = await loadRepoPage("acme", "plain", deps, filters(q));
      if (data.status !== "ok") throw new Error(data.status);
      expect(data.toc, q).toBeNull();
      expect(paths(data.tree), q).toHaveLength(6);
    }
  });

  it("document page: narrows the sidebar, keeps the page being read, keeps previous/next whole", async () => {
    const data = await loadDocPage("acme", "kb", ["a"], deps, filters("type=Table"));
    if (data.status !== "ok") throw new Error(data.status);
    expect(paths(data.navTree)).toEqual(["docs/a.md", "docs/sub/c.md"]);
    expect(paths(data.tree)).toHaveLength(6);
    expect(data.toc?.counts).toEqual({ matches: 1, total: 4 });
    // Previous/next ignore the filters: the whole table of contents, in order.
    expect(data.previous?.path).toBe("docs/index.md");
    expect(data.next?.path).toBe("docs/b.md");
  });

  it("document page: no filters means the whole sidebar", async () => {
    const data = await loadDocPage("acme", "kb", ["a"], deps, filters(""));
    if (data.status !== "ok") throw new Error(data.status);
    expect(paths(data.navTree)).toEqual(paths(data.tree));
    expect(data.toc?.counts).toEqual({ matches: 4, total: 4 });
  });

  it("document page: a repository that is not OKF ignores the filters", async () => {
    const data = await loadDocPage("acme", "plain", ["a"], deps, filters("type=Table&tag=x"));
    if (data.status !== "ok") throw new Error(data.status);
    expect(data.toc).toBeNull();
    expect(data.navTree).toBe(data.tree);
  });

  it("document page: the default (no filters argument) is the whole table of contents", async () => {
    const data = await loadDocPage("acme", "kb", ["a"], deps);
    if (data.status !== "ok") throw new Error(data.status);
    expect(paths(data.navTree)).toHaveLength(6);
  });
});
