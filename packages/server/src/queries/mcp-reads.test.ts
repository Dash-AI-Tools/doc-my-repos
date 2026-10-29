import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documents, repos } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import {
  MAX_OUTLINE_ROWS,
  findOkfGuidelines,
  getRepoOutline,
  listRepoOverviews,
  listRepos,
} from "./index";
import { allowAllRepos, githubPublicReposOnly } from "./visibility";

/**
 * The reads behind the MCP tools (mcp-agent-access task 3.1), on a real database with its own
 * small seed (the shared seed of `queries.test.ts` is counted in many tests). That every one of
 * these queries honours the visibility filter is proved for the whole registry by
 * `queries.test.ts` ("single enforcement point") and `enforcement.test.ts`.
 */

let counter = 0;
async function addRepo(
  t: TestDatabase,
  values: Partial<typeof repos.$inferInsert> & { owner: string; name: string },
): Promise<number> {
  counter += 1;
  const [row] = await t.db
    .insert(repos)
    .values({
      githubId: 5000 + counter,
      visibility: "public",
      defaultBranch: "main",
      htmlUrl: `https://github.com/${values.owner}/${values.name}`,
      ...values,
    })
    .returning({ id: repos.id });
  return row!.id;
}

async function addDocs(
  t: TestDatabase,
  repoId: number,
  list: { path: string; title?: string; body?: string; description?: string }[],
): Promise<void> {
  await t.db.insert(documents).values(
    list.map((d) => {
      const file = (d.path.split("/").pop() ?? "").toLowerCase();
      return {
        repoId,
        path: d.path,
        title: d.title ?? d.path,
        blobSha: `sha-${d.path}`,
        sizeBytes: 10,
        body: d.body ?? `# ${d.title ?? d.path}`,
        description: d.description ?? null,
        reserved:
          file === "index.md" ? ("index" as const) : file === "log.md" ? ("log" as const) : null,
      };
    }),
  );
}

describeDb("agent reads of the query layer", () => {
  let t: TestDatabase;
  let root: number; // guidelines in the docs root
  let guides: number; // guidelines only in docs/guides, spelled differently
  let both: number; // guidelines in both places
  let tie: number; // two spellings in the root
  let none: number; // docs but no guidelines
  let noDocsPath: number; // no docs folder at all
  let blocked: number; // blocked by an admin
  let empty: number; // synced, no documents
  let misplaced: number; // look-alikes that must not match

  beforeAll(async () => {
    t = await createTestDatabase();
    root = await addRepo(t, {
      owner: "Acme",
      name: "Root",
      docsPath: "docs",
      description: "Root repo",
    });
    guides = await addRepo(t, { owner: "acme", name: "guides", docsPath: "Documentation" });
    both = await addRepo(t, { owner: "acme", name: "both", docsPath: "docs" });
    tie = await addRepo(t, { owner: "acme", name: "tie", docsPath: "docs" });
    none = await addRepo(t, {
      owner: "acme",
      name: "none",
      docsPath: "docs",
      isOkf: true,
      okfVersion: "0.2",
    });
    noDocsPath = await addRepo(t, { owner: "acme", name: "nodocs" });
    blocked = await addRepo(t, {
      owner: "acme",
      name: "blocked",
      docsPath: "docs",
      isAllowed: false,
    });
    empty = await addRepo(t, { owner: "acme", name: "empty", docsPath: "docs" });
    misplaced = await addRepo(t, { owner: "acme", name: "misplaced", docsPath: "docs" });

    await addDocs(t, root, [
      { path: "docs/index.md", title: "Overview" },
      {
        path: "docs/okf-guidelines.md",
        title: "Our OKF guidelines",
        body: "# Our OKF guidelines\n\nUse Runbook.",
        description: "House rules",
      },
      { path: "docs/other.md" },
    ]);
    await addDocs(t, guides, [
      { path: "Documentation/Guides/OKF-GUIDELINES.md", title: "Guidelines (shouty)" },
    ]);
    await addDocs(t, both, [
      { path: "docs/guides/okf-guidelines.md", title: "In guides" },
      { path: "docs/okf-guidelines.md", title: "In root" },
    ]);
    await addDocs(t, tie, [
      { path: "docs/okf-guidelines.md", title: "lower" },
      { path: "docs/OKF-Guidelines.md", title: "mixed" },
    ]);
    await addDocs(t, none, [{ path: "docs/a.md" }, { path: "docs/guides/b.md" }]);
    await addDocs(t, blocked, [{ path: "docs/okf-guidelines.md", title: "Hidden" }]);
    await addDocs(t, noDocsPath, [{ path: "okf-guidelines.md", title: "At the repo root" }]);
    await addDocs(t, misplaced, [
      { path: "okf-guidelines.md", title: "outside the docs folder" },
      { path: "docs/sub/okf-guidelines.md", title: "too deep" },
      { path: "docs/guides/sub/okf-guidelines.md", title: "too deep in guides" },
      { path: "docs/okf-guidelines.mdx", title: "wrong extension" },
      { path: "docs/my-okf-guidelines.md", title: "prefix" },
      { path: "docs/okf-guidelines.md.bak", title: "suffix" },
    ]);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  describe("listRepoOverviews", () => {
    it("lists the same repositories in the same order as listRepos, with each docs folder", async () => {
      const cards = await listRepos(t.db);
      const overviews = await listRepoOverviews(t.db);
      expect(overviews.map((r) => r.id)).toEqual(cards.map((r) => r.id));
      expect(overviews.map((r) => `${r.owner}/${r.name}`)).toEqual([
        "acme/both",
        "acme/empty",
        "acme/guides",
        "acme/misplaced",
        "acme/nodocs",
        "acme/none",
        "Acme/Root",
        "acme/tie",
      ]);
      const byName = Object.fromEntries(overviews.map((r) => [r.name, r]));
      expect(byName.Root).toMatchObject({
        owner: "Acme",
        description: "Root repo",
        docsPath: "docs",
        docCount: 3,
        isOkf: false,
      });
      expect(byName.guides?.docsPath).toBe("Documentation");
      expect(byName.nodocs?.docsPath).toBeNull();
      expect(byName.none).toMatchObject({ isOkf: true, okfVersion: "0.2" });
    });

    it("leaves out a blocked repository, and keeps it when the filter allows all", async () => {
      expect((await listRepoOverviews(t.db)).map((r) => r.name)).not.toContain("blocked");
      const all = await listRepoOverviews(t.db, {}, { visibility: allowAllRepos });
      expect(all.map((r) => r.name)).toContain("blocked");
    });

    it("pages with limit and offset and ignores invalid paging values", async () => {
      const all = await listRepoOverviews(t.db);
      expect((await listRepoOverviews(t.db, { limit: 2 })).map((r) => r.id)).toEqual(
        all.slice(0, 2).map((r) => r.id),
      );
      expect((await listRepoOverviews(t.db, { limit: 2, offset: 2 })).map((r) => r.id)).toEqual(
        all.slice(2, 4).map((r) => r.id),
      );
      expect(await listRepoOverviews(t.db, { limit: 0, offset: -3 })).toHaveLength(all.length);
    });

    it("answers with the filter it is given", async () => {
      await t.db.update(repos).set({ visibility: "private" }).where(eqId(none));
      try {
        const publicOnly = await listRepoOverviews(t.db, {}, { visibility: githubPublicReposOnly });
        expect(publicOnly.map((r) => r.name)).not.toContain("none");
      } finally {
        await t.db.update(repos).set({ visibility: "public" }).where(eqId(none));
      }
    });
  });

  describe("getRepoOutline", () => {
    it("returns every document of a small repository in byte order of path, with the total", async () => {
      const outline = await getRepoOutline(t.db, { id: root });
      expect(outline.total).toBe(3);
      expect(outline.docs.map((d) => d.path)).toEqual([
        "docs/index.md",
        "docs/okf-guidelines.md",
        "docs/other.md",
      ]);
      expect(outline.docs[0]).toMatchObject({ reserved: "index", title: "Overview" });
      expect(outline.docs[1]).toMatchObject({ description: "House rules", type: null });
    });

    it("cuts the rows at the limit and still reports the full total", async () => {
      const outline = await getRepoOutline(t.db, { id: root }, 2);
      expect(outline.docs.map((d) => d.path)).toEqual(["docs/index.md", "docs/okf-guidelines.md"]);
      expect(outline.total).toBe(3);
    });

    it("uses the default for an invalid limit and never returns more than the cap", async () => {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_OUTLINE_ROWS + 1]) {
        const outline = await getRepoOutline(t.db, { id: root }, bad);
        expect(outline.docs.length, String(bad)).toBe(3);
      }
      expect(MAX_OUTLINE_ROWS).toBe(1000);
    });

    it("accepts a name as well as an id, ignoring case", async () => {
      const byName = await getRepoOutline(t.db, { owner: "ACME", name: "ROOT" });
      expect(byName.total).toBe(3);
    });

    it("is empty for a repository with no documents and for an unknown one", async () => {
      expect(await getRepoOutline(t.db, { id: empty })).toEqual({ total: 0, docs: [] });
      expect(await getRepoOutline(t.db, { id: 999_999 })).toEqual({ total: 0, docs: [] });
      expect(await getRepoOutline(t.db, { owner: "nobody", name: "nothing" })).toEqual({
        total: 0,
        docs: [],
      });
    });

    it("is empty for a blocked repository unless the filter allows all", async () => {
      expect(await getRepoOutline(t.db, { id: blocked })).toEqual({ total: 0, docs: [] });
      const all = await getRepoOutline(t.db, { id: blocked }, 10, { visibility: allowAllRepos });
      expect(all.total).toBe(1);
    });

    it("bounds the rows in the database for a large repository", async () => {
      const big = await addRepo(t, { owner: "zeta", name: "big", docsPath: "docs" });
      const rows = Array.from({ length: 1500 }, (_, i) => ({
        path: `docs/p-${String(i).padStart(4, "0")}.md`,
      }));
      for (let i = 0; i < rows.length; i += 500) await addDocs(t, big, rows.slice(i, i + 500));
      const outline = await getRepoOutline(t.db, { id: big }, 5000);
      expect(outline.total).toBe(1500);
      expect(outline.docs).toHaveLength(100);
      const wide = await getRepoOutline(t.db, { id: big }, MAX_OUTLINE_ROWS);
      expect(wide.docs).toHaveLength(MAX_OUTLINE_ROWS);
      expect(wide.docs[0]?.path).toBe("docs/p-0000.md");
    });
  });

  describe("findOkfGuidelines", () => {
    it("finds okf-guidelines.md in the docs folder, with its stored fields", async () => {
      const found = await findOkfGuidelines(t.db, { id: root });
      expect(found).toMatchObject({
        path: "docs/okf-guidelines.md",
        title: "Our OKF guidelines",
        description: "House rules",
        body: "# Our OKF guidelines\n\nUse Runbook.",
      });
      expect(found?.updatedAt).toBeInstanceOf(Date);
    });

    it("finds it by name, ignoring the case of the repository name", async () => {
      expect((await findOkfGuidelines(t.db, { owner: "ACME", name: "root" }))?.path).toBe(
        "docs/okf-guidelines.md",
      );
    });

    it("matches the file name and the guides folder case-insensitively", async () => {
      const found = await findOkfGuidelines(t.db, { id: guides });
      expect(found?.path).toBe("Documentation/Guides/OKF-GUIDELINES.md");
      expect(found?.title).toBe("Guidelines (shouty)");
    });

    it("prefers the docs root over the guides folder", async () => {
      expect((await findOkfGuidelines(t.db, { id: both }))?.title).toBe("In root");
    });

    it("takes the lowest path in byte order when two spellings sit in one folder", async () => {
      expect((await findOkfGuidelines(t.db, { id: tie }))?.path).toBe("docs/OKF-Guidelines.md");
    });

    it("finds a file in guides when the root has none", async () => {
      expect((await findOkfGuidelines(t.db, { id: both }))?.path).toBe("docs/okf-guidelines.md");
      await t.db.delete(documents).where(pathIn(both, "docs/okf-guidelines.md"));
      expect((await findOkfGuidelines(t.db, { id: both }))?.path).toBe(
        "docs/guides/okf-guidelines.md",
      );
    });

    it("is null when there is none, even with other documents around", async () => {
      expect(await findOkfGuidelines(t.db, { id: none })).toBeNull();
    });

    it("does not match look-alikes: outside the docs folder, too deep, other names or extensions", async () => {
      expect(await findOkfGuidelines(t.db, { id: misplaced })).toBeNull();
    });

    it("is null for a repository with no docs folder, even with a file at its root", async () => {
      expect(await findOkfGuidelines(t.db, { id: noDocsPath })).toBeNull();
    });

    it("is null for a repository that is synced but has no documents", async () => {
      expect(await findOkfGuidelines(t.db, { id: empty })).toBeNull();
    });

    it("is null for an unknown repository and for malformed references", async () => {
      expect(await findOkfGuidelines(t.db, { id: 999_999 })).toBeNull();
      expect(await findOkfGuidelines(t.db, { id: -1 })).toBeNull();
      expect(await findOkfGuidelines(t.db, { owner: "", name: "x" })).toBeNull();
      expect(await findOkfGuidelines(t.db, { owner: "a\u0000b", name: "x" })).toBeNull();
    });

    it("is null for a blocked repository unless the filter allows all", async () => {
      expect(await findOkfGuidelines(t.db, { id: blocked })).toBeNull();
      const all = await findOkfGuidelines(t.db, { id: blocked }, { visibility: allowAllRepos });
      expect(all?.title).toBe("Hidden");
    });
  });
});

// Small SQL helpers kept below the tests to keep them readable.
import { and, eq } from "drizzle-orm";

function eqId(id: number) {
  return eq(repos.id, id);
}
function pathIn(repoId: number, path: string) {
  return and(eq(documents.repoId, repoId), eq(documents.path, path));
}
