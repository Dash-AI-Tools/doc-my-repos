import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { setRepoAllowed } from "../admin/repos";
import { configSchema, type AppConfigInput } from "../config/schema";
import { createDb, type DbHandle } from "../db/client";
import { apiSpecs, documents, repos, syncRuns } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { createGitHubClient } from "../github/client";
import { getApiSpec, listApiSpecs } from "../queries";
import { createSyncContext, syncAll, type SyncContext } from "./engine";
import { FakeGitHub, gitBlobSha, type FakeRepoInit } from "./fake-github";
import { persistRepoSync, type PersistPlan } from "./persist";

/**
 * Tasks 3.2 to 3.4 of openapi-reference: OpenAPI/Swagger specs through the sync engine (fake
 * GitHub, real database): first sync, unchanged blob not refetched, edits, deletion, rename, a
 * spec that stops parsing, warnings, failed syncs, idempotence, and visibility.
 */

const OWNER = "acme";
const ID = 801;

function spec(title = "Pets", version = "1.0.0", extra = ""): string {
  return [
    "openapi: 3.0.3",
    "info:",
    `  title: ${title}`,
    `  version: "${version}"`,
    "paths:",
    "  /pets:",
    "    get:",
    "      responses:",
    '        "200":',
    "          description: ok",
    extra,
  ].join("\n");
}

function swaggerJson(): string {
  return JSON.stringify({
    swagger: "2.0",
    info: { title: "Legacy", version: "2" },
    paths: { "/a": { get: { responses: { "200": { description: "ok" } } } } },
  });
}

function repo(files: Record<string, string>): FakeRepoInit {
  return { id: ID, name: "svc", visibility: "public", files };
}

describeDb("API specs through the sync engine", () => {
  vi.setConfig({ testTimeout: 60_000 });
  let testDb: TestDatabase;
  let h: DbHandle;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    h = createDb(testDb.url.reveal(), { max: 10 });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await h.db.execute(sql`DROP TRIGGER IF EXISTS fail_code_owners ON code_owners`);
    await h.db.execute(sql`TRUNCATE repos, sync_runs RESTART IDENTITY CASCADE`);
  });

  function ctxFor(fake: FakeGitHub, config: AppConfigInput = {}): SyncContext {
    const github = createGitHubClient({
      getToken: fake.getToken,
      fetch: fake.fetch,
      sleep: async () => undefined,
      maxWaitMs: 1_000,
    });
    return createSyncContext({
      db: h.db,
      pool: h.pool,
      github,
      config: configSchema.parse(config),
    });
  }

  const sync = async (ctx: SyncContext) => {
    const result = await syncAll(ctx, { trigger: "manual" });
    expect(result.run.ran).toBe(true);
    return result;
  };

  async function specs() {
    return h.db
      .select()
      .from(apiSpecs)
      .innerJoin(repos, eq(repos.id, apiSpecs.repoId))
      .where(eq(repos.githubId, ID))
      .orderBy(asc(apiSpecs.path))
      .then((rows) => rows.map((r) => r.api_specs));
  }

  async function repoRow() {
    const [row] = await h.db.select().from(repos).where(eq(repos.githubId, ID));
    return row;
  }

  async function docCount() {
    return (await h.db.select({ id: documents.id }).from(documents)).length;
  }

  async function lastRun() {
    const rows = await h.db.select().from(syncRuns).orderBy(asc(syncRuns.id));
    return rows[rows.length - 1];
  }

  const blobRequests = (fake: FakeGitHub, content: string) =>
    fake.requestsTo(new RegExp(`/git/blobs/${gitBlobSha(content)}$`));

  it("first sync stores specs apart from documents, with their summary columns", async () => {
    const fake = new FakeGitHub({
      owner: OWNER,
      repos: [
        repo({
          "README.md": "# Svc\n",
          "openapi.yaml": spec(),
          "docs/swagger.json": swaggerJson(),
          "docs/guide.md": "# Guide\n",
        }),
      ],
    });
    await sync(ctxFor(fake));

    const rows = await specs();
    expect(rows.map((r) => r.path)).toEqual(["docs/swagger.json", "openapi.yaml"]);
    expect(rows[1]).toMatchObject({
      blobSha: gitBlobSha(spec()),
      sizeBytes: Buffer.byteLength(spec()),
      format: "openapi",
      specVersion: "3.0.3",
      title: "Pets",
      apiVersion: "1.0.0",
      operationCount: 1,
    });
    expect(rows[1]?.spec).toMatchObject({ openapi: "3.0.3", info: { title: "Pets" } });
    expect(rows[0]).toMatchObject({ format: "swagger", specVersion: "2.0", title: "Legacy" });
    // Specs are not documents.
    expect(
      (await h.db.select({ path: documents.path }).from(documents)).map((d) => d.path),
    ).toEqual(["docs/guide.md"]);
    expect((await repoRow())?.syncWarnings).toEqual([]);
  });

  it("does not refetch an unchanged spec blob when the tree changes, and updates an edited one", async () => {
    const fake = new FakeGitHub({
      owner: OWNER,
      repos: [repo({ "openapi.yaml": spec(), "docs/a.md": "# A\n" })],
    });
    const ctx = ctxFor(fake);
    await sync(ctx);
    expect(blobRequests(fake, spec())).toHaveLength(1);
    const [before] = await specs();

    fake.setFile(ID, "docs/a.md", "# A2\n");
    fake.clearRequests();
    await sync(ctx);
    expect(blobRequests(fake, spec())).toHaveLength(0);
    expect(await specs()).toEqual([before]);

    const edited = spec("Pets v2", "2.0.0");
    fake.setFile(ID, "openapi.yaml", edited);
    fake.clearRequests();
    await sync(ctx);
    expect(blobRequests(fake, edited)).toHaveLength(1);
    const [after] = await specs();
    expect(after).toMatchObject({
      id: before?.id,
      title: "Pets v2",
      apiVersion: "2.0.0",
      blobSha: gitBlobSha(edited),
    });
    expect(after?.createdAt).toEqual(before?.createdAt);
    expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(before?.updatedAt.getTime() ?? 0);
  });

  it("leaves a repo with no spec unchanged: no rows, no warnings, documents as before", async () => {
    const fake = new FakeGitHub({
      owner: OWNER,
      repos: [repo({ "README.md": "# Svc\n", "docs/a.md": "# A\n" })],
    });
    const ctx = ctxFor(fake);
    await sync(ctx);
    expect(await specs()).toEqual([]);
    expect(await docCount()).toBe(1);
    const row = await repoRow();
    expect(row).toMatchObject({ syncStatus: "ok", docsPath: "docs" });
    expect(row?.syncWarnings).toEqual([]);
  });

  it("stores specs of a repo that has no docs folder (a no_docs plan)", async () => {
    const fake = new FakeGitHub({ owner: OWNER, repos: [repo({ "openapi.yaml": spec() })] });
    await sync(ctxFor(fake));
    expect((await specs()).map((s) => s.path)).toEqual(["openapi.yaml"]);
    expect((await repoRow())?.docsPath).toBeNull();
  });

  it("removes a deleted spec, and a renamed one moves to its new path", async () => {
    const fake = new FakeGitHub({
      owner: OWNER,
      repos: [repo({ "openapi.yaml": spec(), "swagger.json": swaggerJson() })],
    });
    const ctx = ctxFor(fake);
    await sync(ctx);
    expect((await specs()).map((s) => s.path)).toEqual(["openapi.yaml", "swagger.json"]);

    fake.deleteFile(ID, "swagger.json");
    await sync(ctx);
    expect((await specs()).map((s) => s.path)).toEqual(["openapi.yaml"]);

    fake.deleteFile(ID, "openapi.yaml");
    fake.setFile(ID, "docs/openapi.yml", spec());
    await sync(ctx);
    expect((await specs()).map((s) => s.path)).toEqual(["docs/openapi.yml"]);
  });

  it("removes the stored copy of a spec that stops parsing, warns with a fixed reason, and succeeds", async () => {
    const fake = new FakeGitHub({ owner: OWNER, repos: [repo({ "openapi.yaml": spec() })] });
    const ctx = ctxFor(fake);
    await sync(ctx);
    expect(await specs()).toHaveLength(1);

    const secret = "SECRET-TEXT-IN-A-BROKEN-SPEC";
    fake.setFile(ID, "openapi.yaml", `openapi: 3.0.3\nnote: ${secret}\n`);
    const result = await sync(ctx);
    expect(result.run.ran && result.run.status).toBe("success");
    expect(await specs()).toEqual([]);

    const row = await repoRow();
    expect(row).toMatchObject({ syncStatus: "ok", syncError: null });
    expect(row?.syncWarnings).toEqual([
      {
        code: "api_spec_invalid",
        message:
          "1 file could not be read as an OpenAPI or Swagger description and was not shown as an API reference.",
        count: 1,
        paths: ["openapi.yaml"],
      },
    ]);
    const entry = (await lastRun())?.results.find((r) => r.githubId === ID);
    expect(entry?.status).toBe("ok");
    expect(entry?.warnings).toEqual([
      { path: "openapi.yaml", message: "API spec not stored: missing_info" },
    ]);
    // No spec text anywhere in what was recorded.
    expect(JSON.stringify([row?.syncWarnings, entry])).not.toContain(secret);
  });

  it("warns for an oversized spec and for specs past the limit of ten", async () => {
    const files: Record<string, string> = {};
    for (const base of ["openapi", "swagger"]) {
      for (const ext of ["yaml", "yml", "json"]) {
        files[`${base}.${ext}`] = ext === "json" ? swaggerJson() : spec(`${base}-${ext}`);
        files[`docs/${base}.${ext}`] = ext === "json" ? swaggerJson() : spec(`d-${base}-${ext}`);
      }
    }
    files["docs/a.md"] = "# A\n";
    const fake = new FakeGitHub({ owner: OWNER, repos: [repo(files)] });
    await sync(ctxFor(fake));
    expect(await specs()).toHaveLength(10);
    expect((await repoRow())?.syncWarnings).toEqual([
      {
        code: "api_spec_over_limit",
        message: "Only the first 10 API spec files per repository are shown; 2 files left out.",
        count: 2,
        paths: ["swagger.yaml", "swagger.yml"],
      },
    ]);

    // A lowered size cap skips the larger spec and removes its stored copy.
    const big = spec("Big", "1", `# ${"x".repeat(3000)}`);
    const small = spec("Small");
    const fake2 = new FakeGitHub({
      owner: OWNER,
      repos: [{ id: ID, name: "svc", files: { "openapi.yaml": big, "swagger.yaml": small } }],
    });
    await h.db.execute(sql`TRUNCATE repos RESTART IDENTITY CASCADE`);
    const ctx = ctxFor(fake2);
    await sync(ctx);
    expect(await specs()).toHaveLength(2);
    await sync(ctxFor(fake2, { limits: { maxSpecBytes: 2048 } }));
    expect((await specs()).map((s) => s.path)).toEqual(["swagger.yaml"]);
    expect((await repoRow())?.syncWarnings).toEqual([
      {
        code: "api_spec_too_large",
        message: "1 file larger than 2 KB was not shown as an API reference.",
        count: 1,
        paths: ["openapi.yaml"],
      },
    ]);
  });

  it("warns about a configured path that is not in the repository", async () => {
    const fake = new FakeGitHub({
      owner: OWNER,
      repos: [repo({ "api/spec.yaml": spec(), "openapi.yaml": spec("Ignored") })],
    });
    const config = { repos: [{ name: "svc", apiSpecs: ["api/spec.yaml", "api/gone.yaml"] }] };
    await sync(ctxFor(fake, config));
    // The configured list replaces the default search.
    expect((await specs()).map((s) => s.path)).toEqual(["api/spec.yaml"]);
    expect((await repoRow())?.syncWarnings).toEqual([
      {
        code: "api_spec_missing",
        message: "1 file listed under apiSpecs was not found in the repository.",
        count: 1,
        paths: ["api/gone.yaml"],
      },
    ]);
  });

  it("stores strings with NUL and lone surrogates cleaned", async () => {
    const text = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Nul\u0000Title", version: "1" },
      paths: { "/a": { get: { description: "a\u0000b\ud800c" } } },
    });
    const fake = new FakeGitHub({ owner: OWNER, repos: [repo({ "openapi.json": text })] });
    await sync(ctxFor(fake));
    const [row] = await specs();
    expect(row?.title).toBe("NulTitle");
    expect(JSON.stringify(row?.spec)).not.toContain("\\u0000");
  });

  it("keeps stored specs when a sync fails: GitHub error, failed blob, and database error", async () => {
    const fake = new FakeGitHub({
      owner: OWNER,
      repos: [repo({ "openapi.yaml": spec(), "docs/a.md": "# A\n" })],
    });
    const ctx = ctxFor(fake);
    await sync(ctx);
    const before = await specs();

    // The tree call fails: the repo is in error, content kept.
    fake.setFile(ID, "openapi.yaml", spec("Edited"));
    fake.fail({ path: /\/git\/trees\//, status: 500 });
    await sync(ctx);
    expect((await repoRow())?.syncStatus).toBe("error");
    expect(await specs()).toEqual(before);
    fake.clearFailures();

    // The spec blob cannot be fetched: other content is written, the spec is kept as stored and
    // the sync is incomplete (retried next time).
    fake.fail({ path: new RegExp(`/git/blobs/${gitBlobSha(spec("Edited"))}$`), status: 500 });
    fake.setFile(ID, "docs/a.md", "# A edited\n");
    await sync(ctx);
    expect(await specs()).toEqual(before);
    expect((await h.db.select().from(documents))[0]?.title).toBe("A edited");
    expect((await repoRow())?.treeSha).toBeNull();
    fake.clearFailures();

    // A database error after the spec was written rolls the whole repo back.
    await h.db.execute(sql`
      CREATE OR REPLACE FUNCTION fail_code_owners() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql`);
    await h.db.execute(
      sql`CREATE TRIGGER fail_code_owners BEFORE INSERT ON code_owners
          FOR EACH ROW EXECUTE FUNCTION fail_code_owners()`,
    );
    fake.setFile(ID, "CODEOWNERS", "* @acme/team\n");
    const failed = await sync(ctx);
    expect(failed.run.ran && failed.run.status).toBe("failed");
    expect(await specs()).toEqual(before);
    await h.db.execute(sql`DROP TRIGGER fail_code_owners ON code_owners`);

    // And once the fault is gone the edit lands.
    await sync(ctx);
    expect((await specs())[0]?.title).toBe("Edited");
  });

  it("leaves api_specs identical when the same input is synced twice", async () => {
    const fake = new FakeGitHub({
      owner: OWNER,
      repos: [repo({ "openapi.yaml": spec(), "docs/swagger.json": swaggerJson() })],
    });
    const ctx = ctxFor(fake);
    await sync(ctx);
    const first = await specs();

    // Same tree: short-circuited.
    await sync(ctx);
    expect(await specs()).toEqual(first);

    // Forced re-plan of the same tree and settings: diffed against the stored blobs.
    await h.db.update(repos).set({ treeSha: null, selectionFingerprint: null });
    fake.clearRequests();
    await sync(ctx);
    expect(fake.requestsTo(/\/git\/blobs\//)).toHaveLength(0);
    expect(await specs()).toEqual(first);
  });

  it("hides a blocked repository's specs and restores them on re-allow, without a sync", async () => {
    const fake = new FakeGitHub({ owner: OWNER, repos: [repo({ "openapi.yaml": spec() })] });
    await sync(ctxFor(fake));
    fake.clearRequests();

    // Through the query layer, as the pages read: the default (allowed repos only) filter.
    const ref = { owner: OWNER, name: "svc" };
    const listed = () => listApiSpecs(h.db, ref).then((rows) => rows.map((r) => r.path));
    const fetched = () => getApiSpec(h.db, ref, "openapi.yaml").then((row) => row?.path ?? null);

    expect(await listed()).toEqual(["openapi.yaml"]);
    expect(await fetched()).toBe("openapi.yaml");
    expect(await setRepoAllowed(h.db, OWNER, "svc", false)).toMatchObject({ ok: true });
    expect(await listed()).toEqual([]);
    expect(await fetched()).toBeNull();
    expect(await specs()).toHaveLength(1);
    expect(await setRepoAllowed(h.db, OWNER, "svc", true)).toMatchObject({ ok: true });
    expect(await listed()).toEqual(["openapi.yaml"]);
    expect(await fetched()).toBe("openapi.yaml");
    expect(fake.requestsTo(/./)).toHaveLength(0);
  });
});

describeDb("API specs through persistRepoSync", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  const meta = {
    githubId: 9001,
    owner: "acme",
    name: "persisted",
    description: null,
    defaultBranch: "main",
    archived: false,
    visibility: "public",
    htmlUrl: "https://github.com/acme/persisted",
  };

  const plan = (over: Partial<Extract<PersistPlan, { kind: "content" }>>): PersistPlan => ({
    kind: "content",
    treeSha: "t".repeat(40),
    commitSha: "c".repeat(40),
    headEtag: null,
    selectionFingerprint: "v:fp",
    docsFolder: null,
    fetched: [],
    removed: [],
    failed: [],
    readme: { state: "absent" },
    codeowners: { state: "absent" },
    ...over,
  });

  const fetched = (path: string, text: string) => ({
    path,
    blobSha: gitBlobSha(text),
    size: Buffer.byteLength(text),
    text,
  });

  it("writes an identical re-upsert as a no-op that keeps updated_at", async () => {
    const input = {
      repo: meta,
      plan: plan({
        apiSpecs: {
          fetched: [fetched("openapi.yaml", spec())],
          removed: [],
          failed: [],
          skipped: [],
          missing: [],
        },
      }),
    };
    const first = await persistRepoSync(t.db, input);
    expect(first.apiSpecs).toEqual({ added: 1, updated: 0, identical: 0, removed: 0 });
    const rows1 = await t.db.select().from(apiSpecs);
    const second = await persistRepoSync(t.db, input);
    expect(second.apiSpecs).toEqual({ added: 0, updated: 0, identical: 1, removed: 0 });
    expect(await t.db.select().from(apiSpecs)).toEqual(rows1);
  });

  it("leaves stored specs alone for a plan without an apiSpecs part", async () => {
    await persistRepoSync(t.db, { repo: meta, plan: plan({}) });
    expect(await t.db.select().from(apiSpecs)).toHaveLength(1);
  });

  it("deletes a stored spec whose new content is not a spec", async () => {
    const result = await persistRepoSync(t.db, {
      repo: meta,
      plan: plan({
        apiSpecs: {
          fetched: [fetched("openapi.yaml", "just: text\n")],
          removed: [],
          failed: [],
          skipped: [],
          missing: [],
        },
      }),
    });
    expect(result.apiSpecs.removed).toBe(1);
    expect(result.warnings).toContainEqual({
      path: "openapi.yaml",
      message: "API spec not stored: not_a_spec",
    });
    expect(await t.db.select().from(apiSpecs)).toEqual([]);
  });
});
