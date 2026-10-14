import { asc, eq, getTableColumns, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { codeOwners, documents, repos, SEARCH_TEXT_CONFIG } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { markRepoPrivate } from "../webhooks/store";
import type { RepoLevelResult } from "./blobs";
import {
  PersistError,
  mapVisibility,
  persistRepoSync,
  type PersistFetchedDoc,
  type PersistInput,
  type PersistPlan,
  type PersistRepo,
} from "./persist";
import { databaseInstant } from "./requests";

const sha = (n: number | string) => String(n).padStart(40, "0").slice(-40);

function repoMeta(githubId: number, over: Partial<PersistRepo> = {}): PersistRepo {
  return {
    githubId,
    owner: "acme",
    name: `repo${githubId}`,
    description: "A repo",
    defaultBranch: "main",
    archived: false,
    visibility: "public",
    htmlUrl: `https://github.com/acme/repo${githubId}`,
    ...over,
  };
}

function doc(path: string, text: string, blob: number | string = path): PersistFetchedDoc {
  return {
    path,
    blobSha: sha(typeof blob === "number" ? blob : hash(blob + text)),
    size: Buffer.byteLength(text),
    text,
  };
}

/** Small deterministic hash so changed text means a changed blob SHA in fixtures. */
function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return h;
}

const ABSENT: RepoLevelResult = { state: "absent" };

function content(over: Partial<Extract<PersistPlan, { kind: "content" }>> = {}): PersistPlan {
  return {
    kind: "content",
    treeSha: sha("t1"),
    commitSha: sha("c1"),
    headEtag: 'W/"etag1"',
    selectionFingerprint: "v1:fp",
    docsFolder: "docs",
    fetched: [],
    removed: [],
    failed: [],
    readme: ABSENT,
    codeowners: ABSENT,
    ...over,
  };
}

function readme(text: string, path = "README.md", blob: number = hash(text)): RepoLevelResult {
  return {
    state: "fetched",
    file: { path, blobSha: sha(blob), size: text.length },
    text,
    warnings: [],
  };
}

function codeownersFetched(text: string, path = ".github/CODEOWNERS"): RepoLevelResult {
  return {
    state: "fetched",
    file: { path, blobSha: sha(hash(text)), size: text.length },
    text,
    warnings: [],
  };
}

// Every documents column except the search vector (design: ordinary reads omit it).
const docColumns = Object.fromEntries(
  Object.entries(getTableColumns(documents)).filter(([key]) => key !== "searchVector"),
) as Omit<ReturnType<typeof getTableColumns<typeof documents>>, "searchVector">;

describeDb("persistRepoSync on a real database", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  const persist = (input: PersistInput, options = {}) => persistRepoSync(t.db, input, options);

  async function repoRow(githubId: number) {
    const [row] = await t.db.select().from(repos).where(eq(repos.githubId, githubId));
    return row;
  }

  async function docRows(githubId: number) {
    const row = await repoRow(githubId);
    if (!row) return [];
    return t.db
      .select(docColumns)
      .from(documents)
      .where(eq(documents.repoId, row.id))
      .orderBy(asc(documents.path));
  }

  async function ownerRows(githubId: number) {
    const row = await repoRow(githubId);
    if (!row) return [];
    return t.db
      .select({
        position: codeOwners.position,
        pattern: codeOwners.pattern,
        owners: codeOwners.owners,
        sourcePath: codeOwners.sourcePath,
      })
      .from(codeOwners)
      .where(eq(codeOwners.repoId, row.id))
      .orderBy(asc(codeOwners.position));
  }

  const A = doc("docs/a.md", "---\ntitle: Alpha page\ntype: Metric\n---\nalpha body\n");
  const B = doc("docs/b.md", "# Bravo\n\nbravo body\n");
  const C = doc("docs/sub/c.md", "charlie body\n");

  describe("first sync and idempotence", () => {
    const id = 100;
    const first = (): PersistInput => ({
      repo: repoMeta(id),
      plan: content({
        fetched: [A, B, C],
        readme: readme("# Hello\n"),
        codeowners: codeownersFetched("* @acme/docs\n/docs/ @alice dev@example.com\n"),
      }),
    });

    it("inserts the repo, documents, README and code owners on a first sync", async () => {
      const result = await persist(first());
      expect(result).toMatchObject({
        complete: true,
        added: 3,
        updated: 0,
        identical: 0,
        removed: 0,
        skipped: [],
        failed: [],
        isOkf: true,
        okfVersion: null,
        replacedRepos: [],
      });

      const row = await repoRow(id);
      expect(row).toMatchObject({
        owner: "acme",
        name: "repo100",
        visibility: "public",
        treeSha: sha("t1"),
        selectionFingerprint: "v1:fp",
        headEtag: 'W/"etag1"',
        commitSha: sha("c1"),
        docsPath: "docs",
        isOkf: true,
        readmePath: "README.md",
        readmeMarkdown: "# Hello\n",
        codeownersPath: ".github/CODEOWNERS",
        syncStatus: "ok",
        syncError: null,
      });
      expect(row?.lastSyncedAt).toBeInstanceOf(Date);
      expect(row?.id).toBe(result.repoId);

      const docs = await docRows(id);
      expect(docs.map((d) => [d.path, d.title, d.type])).toEqual([
        ["docs/a.md", "Alpha page", "Metric"],
        ["docs/b.md", "Bravo", null],
        ["docs/sub/c.md", "C", null],
      ]);
      expect(docs[0]?.frontmatter).toEqual({ title: "Alpha page", type: "Metric" });
      expect(docs[0]?.body).toBe("alpha body\n");
      expect(docs[0]?.blobSha).toBe(A.blobSha);

      expect(await ownerRows(id)).toEqual([
        {
          position: 0,
          pattern: "*",
          owners: [{ handle: "@acme/docs", kind: "team" }],
          sourcePath: ".github/CODEOWNERS",
        },
        {
          position: 1,
          pattern: "/docs/",
          owners: [
            { handle: "@alice", kind: "user" },
            { handle: "dev@example.com", kind: "email" },
          ],
          sourcePath: ".github/CODEOWNERS",
        },
      ]);
    });

    it("leaves identical rows when the same input is applied again", async () => {
      const docsBefore = await docRows(id);
      const ownersBefore = await ownerRows(id);
      const result = await persist(first());
      expect(result).toMatchObject({ added: 0, updated: 0, identical: 3, removed: 0 });
      expect(await docRows(id)).toEqual(docsBefore);
      expect(await ownerRows(id)).toEqual(ownersBefore);
      const { rows } = await t.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM repos WHERE github_id = $1",
        [id],
      );
      expect(rows[0]?.n).toBe(1);
    });

    it("an unchanged plan touches no content and refreshes metadata and status", async () => {
      const docsBefore = await docRows(id);
      const before = await repoRow(id);
      const result = await persist({
        repo: repoMeta(id, { description: "New description" }),
        plan: {
          kind: "unchanged",
          treeSha: sha("t1"),
          commitSha: sha("c1"),
          headEtag: 'W/"etag2"',
          selectionFingerprint: "v1:fp",
        },
      });
      expect(result).toMatchObject({ complete: true, added: 0, updated: 0, removed: 0 });
      expect(result.isOkf).toBe(true);
      expect(await docRows(id)).toEqual(docsBefore);
      const after = await repoRow(id);
      expect(after?.description).toBe("New description");
      expect(after?.headEtag).toBe('W/"etag2"');
      expect(after?.readmeMarkdown).toBe(before?.readmeMarkdown);
      expect(after!.lastSyncedAt!.getTime()).toBeGreaterThanOrEqual(
        before!.lastSyncedAt!.getTime(),
      );
    });

    it("rejects an unchanged plan that does not match the stored tree or row", async () => {
      const plan: PersistPlan = {
        kind: "unchanged",
        treeSha: sha("other"),
        commitSha: null,
        headEtag: null,
        selectionFingerprint: "v1:fp",
      };
      await expect(persist({ repo: repoMeta(id), plan })).rejects.toMatchObject({
        kind: "stale_plan",
      });
      await expect(
        persist({ repo: repoMeta(9999), plan: { ...plan, treeSha: sha("t1") } }),
      ).rejects.toMatchObject({ kind: "stale_plan" });
      expect(await repoRow(9999)).toBeUndefined();
    });

    it("updates only the modified document", async () => {
      const before = await docRows(id);
      const B2 = doc("docs/b.md", "# Bravo two\n\nnew body\n");
      const result = await persist({
        repo: repoMeta(id),
        plan: content({ treeSha: sha("t2"), fetched: [B2], codeowners: unchangedOwners() }),
      });
      expect(result).toMatchObject({ added: 0, updated: 1, identical: 0, removed: 0 });
      const after = await docRows(id);
      expect(after.find((d) => d.path === "docs/b.md")).toMatchObject({
        title: "Bravo two",
        blobSha: B2.blobSha,
      });
      const untouched = (rows: typeof before) => rows.filter((d) => d.path !== "docs/b.md");
      expect(untouched(after)).toEqual(untouched(before));
      expect(after.find((d) => d.path === "docs/b.md")!.updatedAt.getTime()).toBeGreaterThan(
        before.find((d) => d.path === "docs/b.md")!.updatedAt.getTime() - 1,
      );
      expect((await repoRow(id))?.treeSha).toBe(sha("t2"));
    });

    it("deletes only the removed path", async () => {
      const result = await persist({
        repo: repoMeta(id),
        plan: content({
          treeSha: sha("t3"),
          removed: [{ path: "docs/sub/c.md" }],
          codeowners: unchangedOwners(),
        }),
      });
      expect(result.removed).toBe(1);
      expect((await docRows(id)).map((d) => d.path)).toEqual(["docs/a.md", "docs/b.md"]);
    });

    function unchangedOwners(): RepoLevelResult {
      const text = "* @acme/docs\n/docs/ @alice dev@example.com\n";
      return {
        state: "unchanged",
        file: { path: ".github/CODEOWNERS", blobSha: sha(hash(text)), size: text.length },
      };
    }
  });

  describe("partial failures", () => {
    const id = 200;

    it("keeps the row of a failed file and clears the head state so the next run retries", async () => {
      await persist({ repo: repoMeta(id), plan: content({ fetched: [A, B] }) });
      const before = await docRows(id);

      const A2 = doc("docs/a.md", "---\ntitle: Alpha v2\n---\nchanged\n");
      const result = await persist({
        repo: repoMeta(id, { visibility: "private" }),
        plan: content({
          treeSha: sha("t2"),
          headEtag: 'W/"etag2"',
          selectionFingerprint: "v1:fp2",
          fetched: [A2],
          failed: [{ path: "docs/b.md" }],
        }),
      });
      expect(result).toMatchObject({ complete: false, updated: 1, failed: ["docs/b.md"] });

      const after = await docRows(id);
      expect(after.find((d) => d.path === "docs/b.md")).toEqual(
        before.find((d) => d.path === "docs/b.md"),
      );
      expect(after.find((d) => d.path === "docs/a.md")?.title).toBe("Alpha v2");

      const row = await repoRow(id);
      // Head state cleared, never advanced, so even a revert to t1 cannot short-circuit.
      expect(row).toMatchObject({
        treeSha: null,
        selectionFingerprint: null,
        headEtag: null,
        commitSha: null,
        visibility: "private",
      });
      // Status is left for task 5.7.
      expect(row?.syncStatus).toBe("ok");

      // The retry that succeeds advances the head state again.
      const retry = await persist({
        repo: repoMeta(id, { visibility: "private" }),
        plan: content({
          treeSha: sha("t2"),
          selectionFingerprint: "v1:fp2",
          fetched: [doc("docs/b.md", "# Bravo again\n")],
        }),
      });
      expect(retry.complete).toBe(true);
      expect(await repoRow(id)).toMatchObject({
        treeSha: sha("t2"),
        selectionFingerprint: "v1:fp2",
      });
    });

    it("never deletes a failed path even when nothing else changed", async () => {
      const result = await persist({
        repo: repoMeta(id, { visibility: "private" }),
        plan: content({ failed: [{ path: "docs/a.md" }, { path: "docs/b.md" }] }),
      });
      expect(result.complete).toBe(false);
      expect((await docRows(id)).map((d) => d.path)).toEqual(["docs/a.md", "docs/b.md"]);
    });

    it("rejects a plan that lists a path as both failed and removed", async () => {
      await expect(
        persist({
          repo: repoMeta(id),
          plan: content({ failed: [{ path: "docs/a.md" }], removed: [{ path: "docs/a.md" }] }),
        }),
      ).rejects.toThrow(TypeError);
      await expect(
        persist({ repo: repoMeta(id), plan: content({ fetched: [doc("other/x.md", "x")] }) }),
      ).rejects.toThrow(TypeError);
    });
  });

  describe("README", () => {
    const id = 300;

    it("stores, moves, keeps on failure and clears when absent", async () => {
      await persist({
        repo: repoMeta(id),
        plan: content({ readme: readme("v1", "README.md", 1) }),
      });
      expect(await repoRow(id)).toMatchObject({
        readmePath: "README.md",
        readmeMarkdown: "v1",
        readmeSha: sha(1),
      });

      // Same content, new path: unchanged by SHA, but the stored path follows.
      await persist({
        repo: repoMeta(id),
        plan: content({
          readme: {
            state: "unchanged",
            file: { path: "readme.markdown", blobSha: sha(1), size: 2 },
          },
        }),
      });
      expect(await repoRow(id)).toMatchObject({
        readmePath: "readme.markdown",
        readmeMarkdown: "v1",
        readmeSha: sha(1),
      });

      // Failed fetch keeps everything and makes the sync incomplete.
      const failed = await persist({
        repo: repoMeta(id),
        plan: content({
          readme: {
            state: "failed",
            file: { path: "README.md", blobSha: sha(2), size: 2 },
            kind: "server",
          },
        }),
      });
      expect(failed).toMatchObject({ complete: false, failed: ["README.md"] });
      expect(await repoRow(id)).toMatchObject({
        readmePath: "readme.markdown",
        readmeMarkdown: "v1",
        readmeSha: sha(1),
        treeSha: null,
      });

      await persist({
        repo: repoMeta(id),
        plan: content({ readme: readme("v2\u0000", "README.md", 2) }),
      });
      expect(await repoRow(id)).toMatchObject({ readmeMarkdown: "v2", readmeSha: sha(2) });

      await persist({ repo: repoMeta(id), plan: content({ readme: ABSENT }) });
      expect(await repoRow(id)).toMatchObject({
        readmePath: null,
        readmeMarkdown: null,
        readmeSha: null,
      });
    });
  });

  describe("code owners", () => {
    const id = 400;

    it("replaces rules in order, keeps them on failure, follows a move and clears when absent", async () => {
      await persist({
        repo: repoMeta(id),
        plan: content({
          codeowners: codeownersFetched("a @one\nb @two\nc @three\n", "CODEOWNERS"),
        }),
      });
      expect((await ownerRows(id)).map((r) => [r.position, r.pattern])).toEqual([
        [0, "a"],
        [1, "b"],
        [2, "c"],
      ]);

      // Fewer rules, new order: old rows are gone, positions restart at 0.
      const text = "z @zed\n# comment\nbad-owner notanowner\ny @why\n";
      const replaced = await persist({
        repo: repoMeta(id),
        plan: content({ codeowners: codeownersFetched(text, "CODEOWNERS") }),
      });
      expect((await ownerRows(id)).map((r) => [r.position, r.pattern, r.owners])).toEqual([
        [0, "z", [{ handle: "@zed", kind: "user" }]],
        [1, "y", [{ handle: "@why", kind: "user" }]],
      ]);
      expect(replaced.warnings.some((w) => w.path === "CODEOWNERS")).toBe(true);
      expect((await repoRow(id))?.codeownersSha).toBe(sha(hash(text)));

      // Failed: rules, path and SHA all kept.
      const before = await ownerRows(id);
      const failed = await persist({
        repo: repoMeta(id),
        plan: content({
          codeowners: {
            state: "failed",
            file: { path: "CODEOWNERS", blobSha: sha(5), size: 1 },
            kind: "network",
          },
        }),
      });
      expect(failed.complete).toBe(false);
      expect(await ownerRows(id)).toEqual(before);
      expect((await repoRow(id))?.codeownersSha).toBe(sha(hash(text)));

      // Same content moved to .github/: path follows on the repo and on the rows.
      await persist({
        repo: repoMeta(id),
        plan: content({
          codeowners: {
            state: "unchanged",
            file: { path: ".github/CODEOWNERS", blobSha: sha(hash(text)), size: text.length },
          },
        }),
      });
      expect((await repoRow(id))?.codeownersPath).toBe(".github/CODEOWNERS");
      expect((await ownerRows(id)).every((r) => r.sourcePath === ".github/CODEOWNERS")).toBe(true);

      // A fetched file with zero rules still stores its SHA and leaves no rows.
      await persist({
        repo: repoMeta(id),
        plan: content({ codeowners: codeownersFetched("# nothing\n") }),
      });
      expect(await ownerRows(id)).toEqual([]);
      expect((await repoRow(id))?.codeownersSha).toBe(sha(hash("# nothing\n")));

      await persist({
        repo: repoMeta(id),
        plan: content({ codeowners: codeownersFetched("x @a\n") }),
      });
      await persist({ repo: repoMeta(id), plan: content({ codeowners: ABSENT }) });
      expect(await ownerRows(id)).toEqual([]);
      expect(await repoRow(id)).toMatchObject({ codeownersPath: null, codeownersSha: null });
    });
  });

  describe("visibility", () => {
    it("maps GitHub values, failing closed", () => {
      expect(mapVisibility("public")).toBe("public");
      expect(mapVisibility("private")).toBe("private");
      expect(mapVisibility("internal")).toBe("private");
      expect(mapVisibility("Public")).toBe("private");
      expect(mapVisibility("")).toBe("private");
    });

    it("updates private to public and public to private with the content", async () => {
      const id = 500;
      await persist({
        repo: repoMeta(id, { visibility: "private" }),
        plan: content({ fetched: [A] }),
      });
      expect((await repoRow(id))?.visibility).toBe("private");

      await persist({
        repo: repoMeta(id, { visibility: "public" }),
        plan: content({ treeSha: sha("t2"), fetched: [B] }),
      });
      expect((await repoRow(id))?.visibility).toBe("public");
      expect((await docRows(id)).map((d) => d.path)).toEqual(["docs/a.md", "docs/b.md"]);

      // An unchanged tree still records the new visibility.
      await persist({
        repo: repoMeta(id, { visibility: "private" }),
        plan: {
          kind: "unchanged",
          treeSha: sha("t2"),
          commitSha: null,
          headEtag: null,
          selectionFingerprint: "v1:fp",
        },
      });
      expect((await repoRow(id))?.visibility).toBe("private");
    });

    it("stores internal as private", async () => {
      await persist({ repo: repoMeta(501, { visibility: "internal" }), plan: content() });
      expect((await repoRow(501))?.visibility).toBe("private");
    });

    it("never writes a listed public over a private stored after the listing (listedAt)", async () => {
      const id = 502;
      const unchanged = (treeSha: string): PersistPlan => ({
        kind: "unchanged",
        treeSha,
        commitSha: null,
        headEtag: null,
        selectionFingerprint: "v1:fp",
      });
      await persist({ repo: repoMeta(id), plan: content({ fetched: [A] }) });
      expect((await repoRow(id))?.visibility).toBe("public");

      // A listing taken, then a `privatized` webhook, then the sync writes that listing.
      const listedAt = await databaseInstant(t.db);
      expect(await markRepoPrivate(t.db, id)).toBe(true);
      const held = await persist(
        { repo: repoMeta(id), plan: content({ treeSha: sha("t2"), fetched: [B] }) },
        { listedAt },
      );
      expect(held.visibilityHeld).toBe(true);
      const row = await repoRow(id);
      expect(row?.visibility).toBe("private");
      // The content is written; a fresh pass is requested to re-read the visibility.
      expect((await docRows(id)).map((d) => d.path)).toEqual(["docs/a.md", "docs/b.md"]);
      expect(row?.syncRequestedAt).not.toBeNull();
      expect(row?.syncStatus).toBe("ok");

      // The unchanged path is guarded the same way.
      const listedAgain = await databaseInstant(t.db);
      await t.db.update(repos).set({ syncRequestedAt: null }).where(eq(repos.githubId, id));
      expect(await markRepoPrivate(t.db, id)).toBe(false); // already private, still bumped
      const heldUnchanged = await persist(
        { repo: repoMeta(id), plan: unchanged(sha("t2")) },
        { listedAt: listedAgain },
      );
      expect(heldUnchanged.visibilityHeld).toBe(true);
      expect((await repoRow(id))?.visibility).toBe("private");
      expect((await repoRow(id))?.syncRequestedAt).not.toBeNull();

      // A listing taken after the privatization (a fresh pass) writes GitHub's public.
      await t.db.update(repos).set({ syncRequestedAt: null }).where(eq(repos.githubId, id));
      const fresh = await persist(
        { repo: repoMeta(id), plan: unchanged(sha("t2")) },
        { listedAt: await databaseInstant(t.db) },
      );
      expect(fresh.visibilityHeld).toBe(false);
      expect((await repoRow(id))?.visibility).toBe("public");
      expect((await repoRow(id))?.syncRequestedAt).toBeNull();

      // A listed private is always written, whatever the instant.
      const old = await databaseInstant(t.db);
      await t.db
        .update(repos)
        .set({ updatedAt: sql`now() + interval '1 hour'` })
        .where(eq(repos.githubId, id));
      const priv = await persist(
        { repo: repoMeta(id, { visibility: "private" }), plan: unchanged(sha("t2")) },
        { listedAt: old },
      );
      expect(priv.visibilityHeld).toBe(false);
      expect((await repoRow(id))?.visibility).toBe("private");
      expect((await repoRow(id))?.syncRequestedAt).toBeNull();

      // A stored public written after the listing is not "held": public stays public.
      await persist({ repo: repoMeta(id), plan: unchanged(sha("t2")) });
      const beforeWrite = await databaseInstant(t.db);
      await t.db
        .update(repos)
        .set({ updatedAt: sql`now() + interval '1 hour'` })
        .where(eq(repos.githubId, id));
      const pub = await persist(
        { repo: repoMeta(id), plan: unchanged(sha("t2")) },
        { listedAt: beforeWrite },
      );
      expect(pub.visibilityHeld).toBe(false);
      expect((await repoRow(id))?.visibility).toBe("public");
    });

    it("creates a new row with the listed visibility whatever listedAt says", async () => {
      const id = 503;
      const listedAt = await databaseInstant(t.db);
      const result = await persist({ repo: repoMeta(id), plan: content() }, { listedAt });
      expect(result.visibilityHeld).toBe(false);
      expect((await repoRow(id))?.visibility).toBe("public");
    });
  });

  describe("renames", () => {
    it("renames in place for the same GitHub id, keeping documents", async () => {
      const id = 600;
      const first = await persist({
        repo: repoMeta(id, { name: "old-name" }),
        plan: content({ fetched: [A] }),
      });
      const second = await persist({
        repo: repoMeta(id, {
          owner: "newco",
          name: "new-name",
          htmlUrl: "https://github.com/newco/new-name",
        }),
        plan: content({ treeSha: sha("t2") }),
      });
      expect(second.repoId).toBe(first.repoId);
      expect(second.replacedRepos).toEqual([]);
      expect(await repoRow(id)).toMatchObject({
        owner: "newco",
        name: "new-name",
        htmlUrl: "https://github.com/newco/new-name",
      });
      expect((await docRows(id)).map((d) => d.path)).toEqual(["docs/a.md"]);
    });

    it("deletes a stale row holding the new name under another id, ignoring case", async () => {
      await persist({ repo: repoMeta(700, { name: "thing" }), plan: content({ fetched: [A, B] }) });
      await persist({
        repo: repoMeta(700, { name: "thing" }),
        plan: content({ codeowners: codeownersFetched("* @x\n") }),
      });
      const staleId = (await repoRow(700))!.id;

      const result = await persist({
        repo: repoMeta(701, { owner: "ACME", name: "Thing" }),
        plan: content({ fetched: [C] }),
      });
      expect(result.replacedRepos).toEqual([{ githubId: 700, owner: "acme", name: "thing" }]);
      expect(await repoRow(700)).toBeUndefined();
      const { rows } = await t.pool.query<{ d: number; o: number }>(
        `SELECT (SELECT count(*)::int FROM documents WHERE repo_id = $1) AS d,
                (SELECT count(*)::int FROM code_owners WHERE repo_id = $1) AS o`,
        [staleId],
      );
      expect(rows[0]).toEqual({ d: 0, o: 0 });
      expect(await repoRow(701)).toMatchObject({ owner: "ACME", name: "Thing" });
      expect((await docRows(701)).map((d) => d.path)).toEqual(["docs/sub/c.md"]);
    });
  });

  describe("OKF and reserved files", () => {
    it("stores reserved kinds and computes OKF over unchanged documents too", async () => {
      const id = 800;
      const index = doc("docs/index.md", '---\nokf_version: "0.2"\n---\n# Home\n');
      const log = doc("docs/log.md", "---\ntype: Log\n---\n# Changes\n");
      const nested = doc("docs/area/index.md", "# Area\n");
      const r1 = await persist({
        repo: repoMeta(id),
        plan: content({ fetched: [index, log, nested] }),
      });
      // A typed log.md is not a typed concept; the root index's okf_version decides.
      expect(r1).toMatchObject({ isOkf: true, okfVersion: "0.2" });
      const rows = await docRows(id);
      expect(rows.map((d) => [d.path, d.reserved])).toEqual([
        ["docs/area/index.md", "index"],
        ["docs/index.md", "index"],
        ["docs/log.md", "log"],
      ]);
      expect(rows.find((d) => d.path === "docs/log.md")?.type).toBe("Log");

      // A later sync that only adds an untyped doc still sees the stored index.
      const r2 = await persist({
        repo: repoMeta(id),
        plan: content({ treeSha: sha("t2"), fetched: [doc("docs/x.md", "plain")] }),
      });
      expect(r2).toMatchObject({ isOkf: true, okfVersion: "0.2" });

      // Removing the index leaves a plain repo.
      const r3 = await persist({
        repo: repoMeta(id),
        plan: content({ treeSha: sha("t3"), removed: [{ path: "docs/index.md" }] }),
      });
      expect(r3).toMatchObject({ isOkf: false, okfVersion: null });
      expect(await repoRow(id)).toMatchObject({ isOkf: false, okfVersion: null });
    });

    it("counts a non-string type key for OKF while the type column stays null", async () => {
      const id = 801;
      const result = await persist({
        repo: repoMeta(id),
        plan: content({ fetched: [doc("docs/n.md", "---\ntype: 42\n---\nbody")] }),
      });
      expect(result.isOkf).toBe(true);
      const [row] = await docRows(id);
      expect(row).toMatchObject({ type: null, frontmatter: { type: 42 } });
      expect(result.warnings.some((w) => w.path === "docs/n.md" && /type/.test(w.message))).toBe(
        true,
      );
    });

    it("is not OKF and stores no docs path when there is no docs folder", async () => {
      const id = 802;
      await persist({ repo: repoMeta(id), plan: content({ fetched: [A] }) });
      const result = await persist({
        repo: repoMeta(id),
        plan: content({ docsFolder: null, treeSha: sha("t2"), removed: [{ path: "docs/a.md" }] }),
      });
      expect(result).toMatchObject({ isOkf: false, removed: 1 });
      expect(await repoRow(id)).toMatchObject({ docsPath: null, isOkf: false });
    });
  });

  describe("untrusted content", () => {
    it("strips NUL and lone surrogates at the database boundary", async () => {
      const id = 900;
      const text = "---\nti\u0000tle: N\u0000UL\nk\ud800: v\n---\n# H\u0000\n\nbo\u0000dy \udc00\n";
      const result = await persist({
        repo: repoMeta(id, { description: "d\u0000esc" }),
        plan: content({
          fetched: [{ ...doc("docs/nul.md", text), warnings: ["nul_stripped"] }],
          codeowners: codeownersFetched("pat\u0000tern @own\u0000er\n"),
        }),
      });
      expect(result.added).toBe(1);
      expect(result.warnings).toContainEqual({
        path: "docs/nul.md",
        message: "NUL characters were removed",
      });
      const [row] = await docRows(id);
      expect(row).toMatchObject({ title: "NUL", body: "# H\n\nbody �\n" });
      expect(row?.frontmatter).toEqual({ title: "NUL", "k�": "v" });
      expect((await repoRow(id))?.description).toBe("desc");
      expect((await ownerRows(id)).map((r) => r.pattern)).toEqual(["pattern"]);
    });

    it("skips an oversized document, deleting its old row, without failing the others", async () => {
      const id = 901;
      await persist({ repo: repoMeta(id), plan: content({ fetched: [A, B] }) });
      const huge = doc("docs/a.md", "x ".repeat(200 * 1024));
      const result = await persist({
        repo: repoMeta(id),
        plan: content({ treeSha: sha("t2"), fetched: [huge, doc("docs/c.md", "fine")] }),
      });
      expect(result).toMatchObject({
        complete: true,
        added: 1,
        removed: 1,
        skipped: [{ path: "docs/a.md", reason: "too_large" }],
      });
      expect(result.warnings.some((w) => w.path === "docs/a.md")).toBe(true);
      expect((await docRows(id)).map((d) => d.path)).toEqual(["docs/b.md", "docs/c.md"]);
      expect((await repoRow(id))?.treeSha).toBe(sha("t2"));
    });

    it("skips a document whose search vector exceeds the tsvector limit, keeping the rest", async () => {
      const id = 902;
      // ~1.9 MB of distinct tokens: over Postgres's 1 MB tsvector limit. The cap is raised so the
      // document reaches the database and the savepoint path is exercised.
      const words = Array.from({ length: 260_000 }, (_, i) => `w${i.toString(36)}`).join(" ");
      const bomb = doc("docs/bomb.md", words);
      await persist({
        repo: repoMeta(id),
        plan: content({ fetched: [doc("docs/bomb.md", "old")] }),
      });
      const result = await persist(
        {
          repo: repoMeta(id),
          plan: content({ treeSha: sha("t2"), fetched: [A, bomb, B] }),
        },
        { maxDocumentBytes: 8 * 1024 * 1024 },
      );
      expect(result).toMatchObject({
        complete: true,
        added: 2,
        removed: 1,
        skipped: [{ path: "docs/bomb.md", reason: "write_rejected" }],
      });
      const warning = result.warnings.find((w) => w.path === "docs/bomb.md");
      expect(warning?.message).toBe(
        "document skipped: the database rejected it (database error (54000))",
      );
      expect((await docRows(id)).map((d) => d.path)).toEqual(["docs/a.md", "docs/b.md"]);
    }, 60_000);
  });

  it("generates a queryable search vector on upsert and update", async () => {
    const id = 1000;
    await persist({
      repo: repoMeta(id),
      plan: content({ fetched: [doc("docs/s.md", "---\ntitle: Zephyrine handbook\n---\nbody")] }),
    });
    const find = async (q: string) =>
      (
        await t.pool.query<{ path: string }>(
          `SELECT d.path FROM documents d JOIN repos r ON r.id = d.repo_id
           WHERE r.github_id = $1 AND d.search_vector @@ websearch_to_tsquery($2::regconfig, $3)`,
          [id, SEARCH_TEXT_CONFIG, q],
        )
      ).rows.map((r) => r.path);
    expect(await find("zephyrine")).toEqual(["docs/s.md"]);

    await persist({
      repo: repoMeta(id),
      plan: content({
        treeSha: sha("t2"),
        fetched: [doc("docs/s.md", "---\ntitle: Quillfeather guide\n---\nbody")],
      }),
    });
    expect(await find("zephyrine")).toEqual([]);
    expect(await find('"quillfeather guide"')).toEqual(["docs/s.md"]);
  });

  describe("atomicity", () => {
    it("rolls back every write when the last statement fails", async () => {
      const id = 1100;
      await persist({
        repo: repoMeta(id, { visibility: "private" }),
        plan: content({
          fetched: [A, B],
          readme: readme("old readme"),
          codeowners: codeownersFetched("* @old\n"),
        }),
      });
      const repoBefore = await repoRow(id);
      const docsBefore = await docRows(id);
      const ownersBefore = await ownerRows(id);

      // The final repos update is the only statement that writes docs_path; fail it.
      await t.pool.query(`
        CREATE FUNCTION test_fail_final_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.docs_path = 'boom' THEN RAISE EXCEPTION 'forced failure' USING ERRCODE = 'P0001'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_fail_final_update BEFORE UPDATE ON repos
          FOR EACH ROW EXECUTE FUNCTION test_fail_final_update();
      `);
      try {
        const error = await persist({
          repo: repoMeta(id, { visibility: "public", name: "renamed" }),
          plan: content({
            treeSha: sha("t2"),
            docsFolder: "boom",
            fetched: [doc("boom/new.md", "new")],
            removed: [{ path: "docs/a.md" }, { path: "docs/b.md" }],
            readme: readme("new readme"),
            codeowners: codeownersFetched("* @new\n"),
          }),
        }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PersistError);
        expect(error).toMatchObject({ kind: "database", code: "P0001" });
        expect((error as Error).message).toBe("persist failed: database error (P0001)");
      } finally {
        await t.pool.query(`
          DROP TRIGGER test_fail_final_update ON repos;
          DROP FUNCTION test_fail_final_update();
        `);
      }

      expect(await repoRow(id)).toEqual(repoBefore);
      expect(await docRows(id)).toEqual(docsBefore);
      expect(await ownerRows(id)).toEqual(ownersBefore);
    });

    it("writes nothing when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        persist(
          { repo: repoMeta(1101), plan: content({ fetched: [A] }) },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ kind: "aborted" });
      expect(await repoRow(1101)).toBeUndefined();
    });
  });

  it("persists two different repositories concurrently", async () => {
    const many = (prefix: string) =>
      Array.from({ length: 40 }, (_, i) => doc(`docs/${prefix}${i}.md`, `# ${prefix} ${i}\n`));
    const [r1, r2] = await Promise.all([
      persist({ repo: repoMeta(1200), plan: content({ fetched: many("p") }) }),
      persist({ repo: repoMeta(1201), plan: content({ fetched: many("q") }) }),
    ]);
    expect(r1.added).toBe(40);
    expect(r2.added).toBe(40);
    expect(await docRows(1200)).toHaveLength(40);
    expect(await docRows(1201)).toHaveLength(40);
  });
});
