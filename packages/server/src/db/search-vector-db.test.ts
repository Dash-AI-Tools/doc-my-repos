import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { SEARCH_TEXT_CONFIG, documents, repos, type Heading } from "./schema";
import { createTestDatabase, describeDb, pgErrorCode, type TestDatabase } from "./test-db";

const GENERATED_COLUMN_WRITE = "428C9";

describeDb("documents.search_vector on a real database", () => {
  let t: TestDatabase;
  let repoId: number;
  let n = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
    const [r] = await t.db
      .insert(repos)
      .values({
        githubId: 1,
        owner: "acme",
        name: "docs",
        defaultBranch: "main",
        visibility: "public",
        htmlUrl: "https://github.com/acme/docs",
      })
      .returning({ id: repos.id });
    repoId = r!.id;
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  async function insertDoc(over: Partial<typeof documents.$inferInsert> = {}): Promise<number> {
    n += 1;
    const [row] = await t.db
      .insert(documents)
      .values({
        repoId,
        path: `docs/${n}.md`,
        blobSha: `sha${n}`,
        sizeBytes: 1,
        title: "Untitled",
        body: "",
        ...over,
      })
      .returning({ id: documents.id });
    return row!.id;
  }

  async function vectorText(id: number): Promise<string> {
    const { rows } = await t.pool.query<{ v: string }>(
      "SELECT search_vector::text AS v FROM documents WHERE id = $1",
      [id],
    );
    return rows[0]!.v;
  }

  it("populates lexemes on insert with weights A, B, C and D", async () => {
    const id = await insertDoc({
      title: "Alpha",
      headings: [{ depth: 2, text: "Bravo", slug: "slug-bravo" }],
      description: "charlie",
      tags: ["delta"],
      body: "echo foxtrot",
    });
    const v = await vectorText(id);
    expect(v).toMatch(/'alpha':\d+A/);
    expect(v).toMatch(/'bravo':\d+B/);
    expect(v).toMatch(/'charlie':\d+C/);
    expect(v).toMatch(/'delta':\d+C/);
    expect(v).toMatch(/'echo':\d+(?: |$)/);
    expect(v).toMatch(/'foxtrot':\d+(?: |$)/);
    // Slug and depth are not indexed.
    expect(v).not.toContain("slug-bravo");
  });

  it("recomputes the vector when the title is updated", async () => {
    const id = await insertDoc({ title: "Oldname", body: "stable" });
    expect(await vectorText(id)).toMatch(/'oldname':\d+A/);
    await t.db.update(documents).set({ title: "Newname" }).where(eq(documents.id, id));
    const v = await vectorText(id);
    expect(v).toMatch(/'newname':\d+A/);
    expect(v).not.toContain("oldname");
    expect(v).toMatch(/'stable':\d+(?: |$)/);
  });

  it("rejects direct INSERT of search_vector", async () => {
    let code: string | undefined;
    try {
      await t.pool.query(
        `INSERT INTO documents (repo_id, path, blob_sha, size_bytes, title, body, search_vector)
         VALUES ($1, 'docs/direct.md', 's', 1, 't', 'b', to_tsvector('simple', 'forged'))`,
        [repoId],
      );
    } catch (error) {
      code = pgErrorCode(error);
    }
    expect(code).toBe(GENERATED_COLUMN_WRITE);
  });

  it("rejects direct UPDATE of search_vector", async () => {
    const id = await insertDoc({ title: "Plain" });
    let code: string | undefined;
    try {
      await t.pool.query(
        "UPDATE documents SET search_vector = to_tsvector('simple', 'forged') WHERE id = $1",
        [id],
      );
    } catch (error) {
      code = pgErrorCode(error);
    }
    expect(code).toBe(GENERATED_COLUMN_WRITE);
    expect(await vectorText(id)).not.toContain("forged");
  });

  it("gives a non-null vector when description, tags and type are empty or null", async () => {
    const id = await insertDoc({ title: "Only title", description: null, type: null, tags: [] });
    const { rows } = await t.pool.query<{ ok: boolean }>(
      "SELECT search_vector IS NOT NULL AS ok FROM documents WHERE id = $1",
      [id],
    );
    expect(rows[0]?.ok).toBe(true);
    expect(await vectorText(id)).toMatch(/'only':\d+A/);
  });

  it("gives a non-null vector for a document with an empty title and body", async () => {
    const id = await insertDoc({ title: "", body: "" });
    const { rows } = await t.pool.query<{ ok: boolean }>(
      "SELECT search_vector IS NOT NULL AS ok FROM documents WHERE id = $1",
      [id],
    );
    expect(rows[0]?.ok).toBe(true);
  });

  const malformed: [string, unknown][] = [
    ["an object", { items: "objectleak", depth: 1 }],
    ["a string", "stringleak"],
    ["a number", 7],
    ["JSON null", sql`'null'::jsonb`],
    ["an array of strings", ["arrayleak", "another"]],
    ["objects without text", [{ slug: "slugleak", depth: 2 }]],
    ["nested text", [{ items: [{ text: "nestedleak" }] }]],
  ];
  for (const [label, headings] of malformed) {
    it(`accepts headings that are ${label} and indexes no text from them`, async () => {
      const id = await insertDoc({ title: "Malformed", headings: headings as Heading[] });
      const v = await vectorText(id);
      expect(v).toMatch(/'malformed':\d+A/);
      expect(v).not.toMatch(/leak|another/);
      expect(v).not.toMatch(/\d+B/);
    });
  }

  it("does not index heading text that is a number, a boolean or an object", async () => {
    // jsonb_to_tsvector with '["all"]' would index 424242 and true; '["string"]' must not.
    const cases: [string, unknown][] = [
      ["a number", [{ depth: 2, text: 424242, slug: "n" }]],
      ["a boolean", [{ depth: 2, text: true, slug: "b" }]],
      // Strings nested inside an object are still indexed (jsonb_to_tsvector recurses), which
      // cannot happen for headings the sync writes; only non-string leaves are covered here.
      ["an object of numbers", [{ depth: 2, text: { inner: 7, deep: [8, true] }, slug: "o" }]],
      ["a numbers-only mix", [{ text: 424242 }, { text: false }, { text: { a: 1 } }]],
    ];
    for (const [label, headings] of cases) {
      const id = await insertDoc({ title: "Typed", headings: headings as unknown as Heading[] });
      const v = await vectorText(id);
      expect(v, label).toMatch(/'typed':\d+A/);
      expect(v, label).not.toMatch(/424242|true|false|inner|deep/);
      expect(v, label).not.toMatch(/\d+B/);
    }
  });

  it("indexes the text of a single heading object stored without an array (jsonpath lax mode)", async () => {
    const id = await insertDoc({
      title: "Lax",
      headings: { depth: 1, text: "Singleobject", slug: "s" } as unknown as Heading[],
    });
    expect(await vectorText(id)).toMatch(/'singleobject':\d+B/);
  });

  it("indexes only the real text entries of a mixed headings array", async () => {
    const id = await insertDoc({
      title: "Mixed",
      headings: [
        { depth: 2, text: "Realheading", slug: "slugvalue" },
        { slug: "noslug" },
        "bare",
        { text: 5 },
        { text: "Second heading", depth: 3, slug: "second" },
      ] as unknown as Heading[],
    });
    const v = await vectorText(id);
    expect(v).toMatch(/'realheading':\d+B/);
    expect(v).toMatch(/'second':\d+B/);
    expect(v).toMatch(/'heading':\d+B/);
    for (const absent of ["slugvalue", "noslug", "bare"]) expect(v).not.toContain(absent);
  });

  it("ranks title above heading above description/tag above body", async () => {
    const word = "zebrafish";
    const base = { body: "filler words only" };
    const inTitle = await insertDoc({ ...base, title: word });
    const inHeading = await insertDoc({
      ...base,
      title: "Other",
      headings: [{ depth: 2, text: word, slug: word }],
    });
    const inDescription = await insertDoc({ ...base, title: "Other", description: word });
    const inTag = await insertDoc({ ...base, title: "Other", tags: [word] });
    const inBody = await insertDoc({ title: "Other", body: `some ${word} text` });

    const { rows } = await t.pool.query<{ id: number; rank: number }>(
      `SELECT id, ts_rank(search_vector, q) AS rank
       FROM documents, websearch_to_tsquery('${SEARCH_TEXT_CONFIG}', $1) AS q
       WHERE search_vector @@ q ORDER BY rank DESC, id`,
      [word],
    );
    const rank = new Map(rows.map((r) => [r.id, r.rank]));
    expect(rows).toHaveLength(5);
    const [title, heading, description, tag, body] = [
      inTitle,
      inHeading,
      inDescription,
      inTag,
      inBody,
    ].map((id) => rank.get(id)!);
    expect(title).toBeGreaterThan(heading!);
    expect(heading).toBeGreaterThan(description!);
    expect(description).toBe(tag);
    expect(description).toBeGreaterThan(body!);
    expect(rows[0]?.id).toBe(inTitle);
    expect(rows[1]?.id).toBe(inHeading);
    expect(rows[4]?.id).toBe(inBody);
  });

  it("matches a websearch query written with operators without building tsquery by hand", async () => {
    await insertDoc({ title: "Deploy guide", body: "rollback steps" });
    const { rows } = await t.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM documents
       WHERE search_vector @@ websearch_to_tsquery('${SEARCH_TEXT_CONFIG}', $1)`,
      ['"deploy guide" -nonexistentword'],
    );
    expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  async function explain(query: string, params: unknown[]): Promise<string> {
    const client = await t.pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      const { rows } = await client.query<Record<string, string>>(`EXPLAIN ${query}`, params);
      return rows.map((r) => Object.values(r)[0]).join("\n");
    } finally {
      client.release();
    }
  }

  it("uses the GIN index for an @@ query", async () => {
    const plan = await explain(
      `SELECT id FROM documents WHERE search_vector @@ websearch_to_tsquery('${SEARCH_TEXT_CONFIG}', $1)`,
      ["zebrafish"],
    );
    expect(plan).toContain("documents_search_vector_idx");
  });

  it("uses the (repo_id, type) index for a type lookup within a repo", async () => {
    const plan = await explain("SELECT id FROM documents WHERE repo_id = $1 AND type = $2", [
      repoId,
      "Runbook",
    ]);
    expect(plan).toContain("documents_repo_id_type_idx");
  });

  it("defines the indexes with the expected method and column order", async () => {
    const { rows } = await t.pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'documents' AND indexname LIKE 'documents\\_%\\_idx'
       ORDER BY indexname`,
    );
    const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(defs["documents_search_vector_idx"]).toMatch(/USING gin \(search_vector\)$/);
    expect(defs["documents_repo_id_type_idx"]).toMatch(/USING btree \(repo_id, type\)$/);
  });

  it("reads back the generated vector through Drizzle as text", async () => {
    const id = await insertDoc({ title: "Drizzleread" });
    const [row] = await t.db
      .select({ v: documents.searchVector })
      .from(documents)
      .where(sql`${documents.id} = ${id}`);
    expect(row?.v).toMatch(/'drizzleread':\d+A/);
  });
});
