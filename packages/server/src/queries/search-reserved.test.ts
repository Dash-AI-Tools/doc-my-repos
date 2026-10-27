import { afterAll, beforeAll, expect, it } from "vitest";

import type { Db } from "../db/client";
import { documents, repos } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { searchDocuments, searchFacets } from "./search";

/**
 * Task 11.6 at the search level: `index.md` and `log.md` are reserved files, not typed concepts,
 * so even when their frontmatter gives them a type, tags or a status they stay out of the type,
 * tag and status facets and filters, and their hits carry no type, tags or status. They are still
 * found by their text.
 */

async function seed(db: Db): Promise<number> {
  const [row] = await db
    .insert(repos)
    .values({
      githubId: 1,
      owner: "acme",
      name: "kb",
      visibility: "public",
      defaultBranch: "main",
      htmlUrl: "https://github.com/acme/kb",
      docsPath: "docs",
      isOkf: true,
    })
    .returning({ id: repos.id });
  if (row === undefined) throw new Error("insert failed");
  const base = (path: string, reserved: "index" | "log" | null) => ({
    repoId: row.id,
    path,
    title: path,
    blobSha: `sha-${path}`,
    sizeBytes: 10,
    body: "reservedword text",
    reserved,
  });
  await db.insert(documents).values([
    { ...base("docs/a.md", null), type: "Concept", tags: ["finance"], status: "active" },
    { ...base("docs/b.md", null), type: "Runbook", tags: ["ops"], status: "draft" },
    {
      ...base("docs/index.md", "index"),
      type: "Index",
      tags: ["finance", "root"],
      status: "active",
    },
    { ...base("docs/log.md", "log"), type: "Log", tags: ["root"], status: "draft" },
  ]);
  return row.id;
}

describeDb("search and reserved files (task 11.6)", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
    await seed(t.db);
  });
  afterAll(async () => {
    await t.close();
  });

  it("still finds the reserved files by their text, without type, tags or status", async () => {
    const result = await searchDocuments(t.db, { q: "reservedword" });
    expect(result.hits.map((h) => h.doc.path).sort()).toEqual([
      "docs/a.md",
      "docs/b.md",
      "docs/index.md",
      "docs/log.md",
    ]);
    for (const hit of result.hits) {
      if (hit.doc.reserved === null) {
        expect(hit.doc.type).not.toBeNull();
      } else {
        expect(hit.doc).toMatchObject({ type: null, tags: [], status: null });
      }
    }
  });

  it("keeps them out of the facet counts", async () => {
    const facets = await searchFacets(t.db, { q: "reservedword" });
    expect(facets.total).toBe(4);
    expect(facets.types).toEqual([
      { value: "Concept", count: 1 },
      { value: "Runbook", count: 1 },
    ]);
    expect(facets.tags).toEqual([
      { value: "finance", count: 1 },
      { value: "ops", count: 1 },
    ]);
    expect(facets.statuses).toEqual([
      { value: "active", count: 1 },
      { value: "draft", count: 1 },
    ]);
  });

  it("keeps them out of type, tag and status filter results", async () => {
    for (const filter of [
      { type: "Index" },
      { type: "Log" },
      { tag: "root" },
      { type: ["Log", "Index"], status: "draft" },
    ]) {
      const result = await searchDocuments(t.db, { q: "reservedword", ...filter });
      expect(result.hits, JSON.stringify(filter)).toEqual([]);
      expect(result.total).toBe(0);
    }
    const finance = await searchDocuments(t.db, { q: "reservedword", tag: "finance" });
    expect(finance.hits.map((h) => h.doc.path)).toEqual(["docs/a.md"]);
    const draft = await searchDocuments(t.db, { q: "reservedword", status: "draft" });
    expect(draft.hits.map((h) => h.doc.path)).toEqual(["docs/b.md"]);
    const facets = await searchFacets(t.db, { q: "reservedword", status: "draft" });
    expect(facets.total).toBe(1);
  });
});
