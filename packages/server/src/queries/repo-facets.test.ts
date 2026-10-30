import { afterAll, beforeAll, expect, it } from "vitest";

import {
  countTocRows,
  filterDocsRows,
  parseTocFilters,
} from "@docmyrepos/core/internal/toc-filters";
import type { Db } from "../db/client";
import { documents, repos } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { getDocsTree } from "./documents";
import { getRepoFacets } from "./search";
import { githubPublicReposOnly } from "./visibility";

/**
 * `getRepoFacets` (task 11.2 and 11.3) on a real database: the counts behind the type, tag and
 * status filters of a repository's table of contents. The registry test (`queries.test.ts`) covers
 * the visibility flip; this file covers what is counted.
 */

type Seed = { kb: number; secret: number; plain: number };

async function insertRepo(
  db: Db,
  values: Pick<typeof repos.$inferInsert, "githubId" | "owner" | "name" | "visibility"> &
    Partial<typeof repos.$inferInsert>,
): Promise<number> {
  const [row] = await db
    .insert(repos)
    .values({
      defaultBranch: "main",
      htmlUrl: `https://github.com/${values.owner}/${values.name}`,
      docsPath: "docs",
      ...values,
    })
    .returning({ id: repos.id });
  if (row === undefined) throw new Error("insert failed");
  return row.id;
}

function doc(
  repoId: number,
  path: string,
  extra: Partial<typeof documents.$inferInsert> = {},
): typeof documents.$inferInsert {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  return {
    repoId,
    path,
    title: path,
    blobSha: `sha-${path}`,
    sizeBytes: 10,
    body: "Body.",
    reserved: name === "index.md" ? "index" : name === "log.md" ? "log" : null,
    ...extra,
  };
}

async function seed(db: Db): Promise<Seed> {
  const kb = await insertRepo(db, {
    githubId: 1,
    owner: "acme",
    name: "kb",
    visibility: "public",
    isOkf: true,
    okfVersion: "0.2",
  });
  const secret = await insertRepo(db, {
    githubId: 2,
    owner: "acme",
    name: "secret",
    visibility: "private",
    isOkf: true,
  });
  const plain = await insertRepo(db, {
    githubId: 3,
    owner: "acme",
    name: "plain",
    visibility: "public",
  });
  await db.insert(documents).values([
    // Reserved files carry values on purpose: they must never be counted.
    doc(kb, "docs/index.md", { type: "Concept", tags: ["root"], status: "active" }),
    doc(kb, "docs/log.md", { type: "Log", tags: ["root"], status: "active" }),
    doc(kb, "docs/a.md", { type: "Concept", tags: ["finance", "core"], status: "active" }),
    doc(kb, "docs/b.md", { type: "Concept", tags: ["finance"], status: "draft" }),
    doc(kb, "docs/c.md", { type: "concept", tags: ["core"], status: "active" }),
    doc(kb, "docs/d.md", { type: "Table", status: "deprecated" }),
    // Untyped: counted for tags, never for types.
    doc(kb, "docs/e.md", { tags: ["finance"] }),
    // A repeated tag counts the document once.
    doc(kb, "docs/f.md", { type: "Runbook", tags: ["finance", "finance"] }),
    doc(secret, "docs/s1.md", { type: "Secret", tags: ["hidden"], status: "active" }),
    doc(plain, "docs/p1.md", { tags: ["x"] }),
  ]);
  return { kb, secret, plain };
}

describeDb("getRepoFacets on a real database", () => {
  let t: TestDatabase;
  let s: Seed;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await seed(t.db);
  });
  afterAll(async () => {
    await t.close();
  });

  it("counts types, tags and statuses of non-reserved documents, ordered by count then value", async () => {
    const facets = await getRepoFacets(t.db, { id: s.kb });
    expect(facets).toEqual({
      total: 6,
      // `Concept` and `concept` are two values; ties sort by byte order (upper case first).
      types: [
        { value: "Concept", count: 2 },
        { value: "Runbook", count: 1 },
        { value: "Table", count: 1 },
        { value: "concept", count: 1 },
      ],
      // `root` is only on reserved files; `finance` on a.md, b.md, e.md and f.md (f.md once).
      tags: [
        { value: "finance", count: 4 },
        { value: "core", count: 2 },
      ],
      statuses: [
        { value: "active", count: 2 },
        { value: "deprecated", count: 1 },
        { value: "draft", count: 1 },
      ],
    });
  });

  it("names the repository by id or owner/name, any case", async () => {
    const byId = await getRepoFacets(t.db, { id: s.kb });
    expect(await getRepoFacets(t.db, { owner: "ACME", name: "KB" })).toEqual(byId);
  });

  it("counts each kind over the documents passing the OTHER kinds' filters (disjunctive)", async () => {
    const concept = await getRepoFacets(t.db, { id: s.kb }, { type: "Concept" });
    expect(concept.total).toBe(2);
    // Types ignore the type filter: the other types stay visible with their counts.
    expect(concept.types.map((x) => `${x.value}:${x.count}`)).toEqual([
      "Concept:2",
      "Runbook:1",
      "Table:1",
      "concept:1",
    ]);
    expect(concept.tags).toEqual([
      { value: "finance", count: 2 },
      { value: "core", count: 1 },
    ]);
    expect(concept.statuses).toEqual([
      { value: "active", count: 1 },
      { value: "draft", count: 1 },
    ]);

    const combined = await getRepoFacets(
      t.db,
      { id: s.kb },
      { type: "Concept", tag: "core", status: "active" },
    );
    expect(combined.total).toBe(1);
    expect(combined.types).toEqual([
      { value: "Concept", count: 1 },
      { value: "concept", count: 1 },
    ]);
    // Tags of the active Concept documents (only a.md); the tag filter itself is not applied.
    // Ties sort by value.
    expect(combined.tags).toEqual([
      { value: "core", count: 1 },
      { value: "finance", count: 1 },
    ]);
    expect(combined.statuses).toEqual([{ value: "active", count: 1 }]);
  });

  it("ORs values of one kind and ANDs the kinds", async () => {
    expect((await getRepoFacets(t.db, { id: s.kb }, { type: ["Concept", "concept"] })).total).toBe(
      3,
    );
    expect(
      (await getRepoFacets(t.db, { id: s.kb }, { type: ["Concept", "Table"], status: "draft" }))
        .total,
    ).toBe(1);
    expect((await getRepoFacets(t.db, { id: s.kb }, { tag: ["core", "finance"] })).total).toBe(5);
    // A document without a type never matches a type filter.
    expect((await getRepoFacets(t.db, { id: s.kb }, { type: "Runbook", tag: "core" })).total).toBe(
      0,
    );
  });

  it("matches values exactly: no case folding, no trimming", async () => {
    expect((await getRepoFacets(t.db, { id: s.kb }, { type: "CONCEPT" })).total).toBe(0);
    expect((await getRepoFacets(t.db, { id: s.kb }, { type: " Concept" })).total).toBe(0);
    expect((await getRepoFacets(t.db, { id: s.kb }, { type: "concept" })).total).toBe(1);
  });

  it("never throws on hostile filter values and matches nothing for them", async () => {
    const hostile: unknown[] = [
      "'; drop table documents; --",
      "\u0000",
      "x".repeat(10_000),
      "\uD800",
      "",
      [],
      123,
      { a: 1 },
      null,
      ["a", 5, null],
    ];
    for (const value of hostile) {
      const label = JSON.stringify(value)?.slice(0, 40);
      for (const key of ["type", "tag", "status"] as const) {
        const facets = await getRepoFacets(t.db, { id: s.kb }, { [key]: value });
        // Absent filter kinds ([] and null count as absent) leave the counts alone; anything
        // given that cannot match a stored value matches nothing.
        const absent = value === null || (Array.isArray(value) && value.length === 0);
        expect(facets.total, `${key} ${label}`).toBe(absent ? 6 : 0);
      }
    }
    // The table is still there.
    expect((await getRepoFacets(t.db, { id: s.kb })).total).toBe(6);
  });

  it("returns nothing for unknown references and for odd ids", async () => {
    const none = { total: 0, types: [], tags: [], statuses: [] };
    expect(await getRepoFacets(t.db, { id: 999_999 })).toEqual(none);
    expect(await getRepoFacets(t.db, { id: -1 })).toEqual(none);
    expect(await getRepoFacets(t.db, { owner: "nobody", name: "kb" })).toEqual(none);
    expect(await getRepoFacets(t.db, { owner: "a\u0000b", name: "kb" })).toEqual(none);
  });

  it("hides a private repository when the visibility filter hides it", async () => {
    expect((await getRepoFacets(t.db, { id: s.secret })).total).toBe(1);
    expect(
      await getRepoFacets(t.db, { id: s.secret }, {}, { visibility: githubPublicReposOnly }),
    ).toEqual({ total: 0, types: [], tags: [], statuses: [] });
  });

  it("does not mix repositories", async () => {
    const plain = await getRepoFacets(t.db, { id: s.plain });
    expect(plain).toEqual({ total: 1, types: [], tags: [{ value: "x", count: 1 }], statuses: [] });
  });

  it("agrees with the pure row filter the tree is built from", async () => {
    const rows = await getDocsTree(t.db, { id: s.kb });
    const queries = [
      "",
      "type=Concept",
      "type=Concept&type=concept",
      "tag=core",
      "type=Concept&tag=finance",
      "status=active&tag=core&tag=finance",
      "type=Table&status=draft",
      "type=Nope",
    ];
    for (const query of queries) {
      const params = new URLSearchParams(query);
      const state = parseTocFilters(params);
      const facets = await getRepoFacets(
        t.db,
        { id: s.kb },
        { type: params.getAll("type"), tag: params.getAll("tag"), status: params.getAll("status") },
      );
      expect(facets.total, query).toBe(countTocRows(rows, state).matches);
      expect(filterDocsRows(rows, state).filter((r) => r.reserved === null).length, query).toBe(
        facets.total,
      );
    }
  });
});
