import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { codeOwners, docComments, documents, repos, siteBranding, syncRuns, users } from "./schema";
import { createTestDatabase, describeDb, pgErrorCode, type TestDatabase } from "./test-db";

let counter = 0;
const repoValues = (over: Partial<typeof repos.$inferInsert> = {}): typeof repos.$inferInsert => {
  counter += 1;
  return {
    githubId: 1000 + counter,
    owner: "acme",
    name: `repo-${counter}`,
    defaultBranch: "main",
    visibility: "public",
    htmlUrl: `https://github.com/acme/repo-${counter}`,
    ...over,
  };
};

const docValues = (
  repoId: number,
  over: Partial<typeof documents.$inferInsert> = {},
): typeof documents.$inferInsert => {
  counter += 1;
  return {
    repoId,
    path: `docs/doc-${counter}.md`,
    blobSha: `sha${counter}`,
    sizeBytes: 10,
    title: "Title",
    body: "Body",
    ...over,
  };
};

async function codeOf(promise: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return pgErrorCode(error);
  }
  return undefined;
}

const UNIQUE_VIOLATION = "23505";
const NOT_NULL_VIOLATION = "23502";
const INVALID_ENUM = "22P02";

describeDb("table constraints on a real database", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("rejects a repo with a duplicate (owner, name)", async () => {
    await t.db.insert(repos).values(repoValues({ owner: "dup", name: "same" }));
    expect(
      await codeOf(t.db.insert(repos).values(repoValues({ owner: "dup", name: "same" }))),
    ).toBe(UNIQUE_VIOLATION);
    // Same name under another owner is fine.
    await t.db.insert(repos).values(repoValues({ owner: "other", name: "same" }));
  });

  it("rejects a repo with a duplicate github_id", async () => {
    await t.db.insert(repos).values(repoValues({ githubId: 42 }));
    expect(await codeOf(t.db.insert(repos).values(repoValues({ githubId: 42 })))).toBe(
      UNIQUE_VIOLATION,
    );
  });

  it("accepts public and private visibility only, and requires one", async () => {
    await t.db.insert(repos).values(repoValues({ visibility: "private" }));
    for (const bad of ["secret", "", "Public", "internal"]) {
      const code = await codeOf(
        t.pool.query(
          `INSERT INTO repos (github_id, owner, name, default_branch, visibility, html_url)
           VALUES ($1, 'v', $2, 'main', $3, 'u')`,
          [90_000 + counter++, `v-${counter}`, bad],
        ),
      );
      expect(code, `visibility ${JSON.stringify(bad)}`).toBe(INVALID_ENUM);
    }
    const nullCode = await codeOf(
      t.pool.query(
        `INSERT INTO repos (github_id, owner, name, default_branch, visibility, html_url)
         VALUES ($1, 'v', 'vnull', 'main', NULL, 'u')`,
        [90_000 + counter++],
      ),
    );
    expect(nullCode).toBe(NOT_NULL_VIOLATION);
    // Omitting the column is also rejected: there is no default.
    const omitted = await codeOf(
      t.pool.query(
        `INSERT INTO repos (github_id, owner, name, default_branch, html_url)
         VALUES ($1, 'v', 'vomit', 'main', 'u')`,
        [90_000 + counter++],
      ),
    );
    expect(omitted).toBe(NOT_NULL_VIOLATION);
  });

  it("defaults a new repo to sync_status pending and archived false", async () => {
    const { rows } = await t.pool.query<{
      sync_status: string;
      archived: boolean;
      is_okf: boolean;
    }>(
      `INSERT INTO repos (github_id, owner, name, default_branch, visibility, html_url)
       VALUES ($1, 'defaults', 'repo', 'main', 'public', 'u')
       RETURNING sync_status, archived, is_okf`,
      [80_000 + counter++],
    );
    expect(rows[0]).toEqual({ sync_status: "pending", archived: false, is_okf: false });
  });

  it("makes document paths unique per repo only", async () => {
    const [a, b] = await t.db
      .insert(repos)
      .values([repoValues(), repoValues()])
      .returning({ id: repos.id });
    const idA = a!.id;
    const idB = b!.id;
    await t.db.insert(documents).values(docValues(idA, { path: "docs/a.md" }));
    expect(await codeOf(t.db.insert(documents).values(docValues(idA, { path: "docs/a.md" })))).toBe(
      UNIQUE_VIOLATION,
    );
    await t.db.insert(documents).values(docValues(idB, { path: "docs/a.md" }));
  });

  it("makes code owner positions unique per repo only", async () => {
    const [a, b] = await t.db
      .insert(repos)
      .values([repoValues(), repoValues()])
      .returning({ id: repos.id });
    const rule = (repoId: number, position: number): typeof codeOwners.$inferInsert => ({
      repoId,
      position,
      pattern: "*",
      owners: [{ handle: "@acme/docs", kind: "team" }],
      sourcePath: ".github/CODEOWNERS",
    });
    await t.db.insert(codeOwners).values(rule(a!.id, 0));
    expect(await codeOf(t.db.insert(codeOwners).values(rule(a!.id, 0)))).toBe(UNIQUE_VIOLATION);
    await t.db.insert(codeOwners).values([rule(a!.id, 1), rule(b!.id, 0)]);
  });

  it("deletes documents and code owners with their repo, and no others", async () => {
    const [gone, kept] = await t.db
      .insert(repos)
      .values([repoValues(), repoValues()])
      .returning({ id: repos.id });
    for (const r of [gone!, kept!]) {
      await t.db.insert(documents).values([docValues(r.id), docValues(r.id)]);
      await t.db.insert(codeOwners).values({
        repoId: r.id,
        position: 0,
        pattern: "*",
        owners: [],
        sourcePath: "CODEOWNERS",
      });
    }
    await t.db.delete(repos).where(eq(repos.id, gone!.id));
    expect(await t.db.select().from(codeOwners).where(eq(codeOwners.repoId, gone!.id))).toEqual([]);
    const docsLeft = await t.db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.repoId, gone!.id));
    expect(docsLeft).toEqual([]);
    const keptDocs = await t.db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.repoId, kept!.id));
    expect(keptDocs).toHaveLength(2);
    expect(
      await t.db.select().from(codeOwners).where(eq(codeOwners.repoId, kept!.id)),
    ).toHaveLength(1);
  });

  it("rejects a document for a repo that does not exist", async () => {
    expect(await codeOf(t.db.insert(documents).values(docValues(2_000_000_000)))).toBe("23503");
  });

  it("keeps sync_runs when a repo is deleted", async () => {
    const [r] = await t.db
      .insert(repos)
      .values(repoValues({ owner: "runs", name: "kept" }))
      .returning({ id: repos.id });
    const [run] = await t.db
      .insert(syncRuns)
      .values({ trigger: "manual", scope: "runs/kept" })
      .returning({ id: syncRuns.id });
    await t.db.delete(repos).where(eq(repos.id, r!.id));
    const rows = await t.db.select().from(syncRuns).where(eq(syncRuns.id, run!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "runs/kept", status: "running" });
  });

  it("stores documents.type case-sensitively, and NULL as NULL", async () => {
    const [r] = await t.db.insert(repos).values(repoValues()).returning({ id: repos.id });
    await t.db
      .insert(documents)
      .values([
        docValues(r!.id, { path: "docs/1.md", type: "Runbook" }),
        docValues(r!.id, { path: "docs/2.md", type: "runbook" }),
        docValues(r!.id, { path: "docs/3.md", type: "RUNBOOK " }),
        docValues(r!.id, { path: "docs/4.md" }),
      ]);
    const rows = await t.db
      .select({ path: documents.path, type: documents.type })
      .from(documents)
      .where(eq(documents.repoId, r!.id))
      .orderBy(documents.path);
    expect(rows.map((x) => x.type)).toEqual(["Runbook", "runbook", "RUNBOOK ", null]);
    const { rows: distinct } = await t.pool.query<{ n: number }>(
      "SELECT count(DISTINCT type)::int AS n FROM documents WHERE repo_id = $1",
      [r!.id],
    );
    expect(distinct[0]?.n).toBe(3);
  });

  it("keeps site_branding to one row", async () => {
    await t.db.insert(siteBranding).values({ id: 1, orgName: "Acme" });
    expect(await codeOf(t.db.insert(siteBranding).values({ id: 1, orgName: "Dup" }))).toBe(
      UNIQUE_VIOLATION,
    );
    expect(await codeOf(t.db.insert(siteBranding).values({ id: 2, orgName: "Other" }))).toBe(
      "23514",
    );
  });

  describe("doc_comments", () => {
    const comment = (
      over: Partial<typeof docComments.$inferInsert> = {},
    ): typeof docComments.$inferInsert => ({
      githubRepoId: 424242,
      path: "docs/a.md",
      authorLabel: "ana",
      body: "hello",
      ...over,
    });
    const newUser = async (email: string) => {
      const [u] = await t.db.insert(users).values({ email, passwordHash: "x" }).returning();
      return u!;
    };

    it("accepts a 4000 character body and rejects 4001 (characters, not bytes)", async () => {
      await t.db.insert(docComments).values(comment({ body: "x".repeat(4000) }));
      await t.db.insert(docComments).values(comment({ body: "\u{1F600}".repeat(4000) }));
      expect(
        await codeOf(t.db.insert(docComments).values(comment({ body: "x".repeat(4001) }))),
      ).toBe("23514");
    });

    it("rejects a resolved reply but allows a resolved root", async () => {
      const [root] = await t.db
        .insert(docComments)
        .values(comment({ resolvedAt: new Date() }))
        .returning();
      expect(
        await codeOf(
          t.db.insert(docComments).values(comment({ parentId: root!.id, resolvedAt: new Date() })),
        ),
      ).toBe("23514");
    });

    it("deletes replies with their root", async () => {
      const [root] = await t.db
        .insert(docComments)
        .values(comment({ path: "docs/c.md" }))
        .returning();
      await t.db
        .insert(docComments)
        .values([
          comment({ path: "docs/c.md", parentId: root!.id }),
          comment({ path: "docs/other.md" }),
        ]);
      await t.db.delete(docComments).where(eq(docComments.id, root!.id));
      const left = await t.db.select().from(docComments).where(eq(docComments.path, "docs/c.md"));
      expect(left).toEqual([]);
      const other = await t.db
        .select()
        .from(docComments)
        .where(eq(docComments.path, "docs/other.md"));
      expect(other).toHaveLength(1);
    });

    it("sets author_id and resolved_by to null when the user is removed, keeping the label", async () => {
      const u = await newUser("gone@example.com");
      const [c] = await t.db
        .insert(docComments)
        .values(comment({ authorId: u.id, resolvedBy: u.id, authorLabel: "gone" }))
        .returning();
      await t.db.delete(users).where(eq(users.id, u.id));
      const [after] = await t.db.select().from(docComments).where(eq(docComments.id, c!.id));
      expect(after).toMatchObject({ authorId: null, resolvedBy: null, authorLabel: "gone" });
    });

    it("is untouched when the repo or document row is deleted", async () => {
      const [r] = await t.db
        .insert(repos)
        .values(repoValues({ githubId: 777001 }))
        .returning();
      const [d] = await t.db
        .insert(documents)
        .values(docValues(r!.id, { path: "docs/x.md" }))
        .returning();
      await t.db
        .insert(docComments)
        .values([
          comment({ githubRepoId: 777001, path: "docs/x.md" }),
          comment({ githubRepoId: 777001, path: "docs/y.md" }),
        ]);
      const count = async () =>
        (await t.db.select().from(docComments).where(eq(docComments.githubRepoId, 777001))).length;
      await t.db.delete(documents).where(eq(documents.id, d!.id));
      expect(await count()).toBe(2);
      await t.db.delete(repos).where(eq(repos.id, r!.id));
      expect(await count()).toBe(2);
    });
  });
});
