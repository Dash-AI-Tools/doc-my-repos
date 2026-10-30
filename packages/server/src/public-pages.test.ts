import { afterAll, beforeAll, expect, it } from "vitest";

import { apiSpecs, documents, repoFolders, repos } from "./db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "./db/test-db";
import { loadApiReference } from "./api-reference-page";
import { loadDocPage } from "./doc-page";
import { loadRepoPage } from "./repo-page";
import { loadSearchPage } from "./search-page";
import { parseSearchParams } from "@docmyrepos/core/internal/search-params";
import { ANONYMOUS, MEMBER } from "./queries/visibility";

/**
 * The repository, document and API reference pages for a visitor without a session (public
 * access): a public repository reads as it does for a member, and a repository that is not public,
 * blocked, or in a folder that is not public is "not found" for them, with nothing of it loaded.
 */

describeDb("repository pages read through the reader's filter", () => {
  let t: TestDatabase;
  const ids: Record<string, number> = {};
  beforeAll(async () => {
    t = await createTestDatabase();
    const [folder] = await t.db
      .insert(repoFolders)
      .values({ name: "Open", isPublic: true })
      .returning({ id: repoFolders.id });
    const make = async (
      githubId: number,
      name: string,
      over: Partial<typeof repos.$inferInsert> = {},
    ) => {
      const [row] = await t.db
        .insert(repos)
        .values({
          githubId,
          owner: "acme",
          name,
          defaultBranch: "main",
          visibility: "private",
          htmlUrl: `https://github.com/acme/${name}`,
          docsPath: "docs",
          ...over,
        })
        .returning({ id: repos.id });
      ids[name] = row!.id;
      await t.db.insert(documents).values({
        repoId: row!.id,
        path: "docs/guide.md",
        title: `Guide of ${name}`,
        blobSha: `sha-${name}`,
        sizeBytes: 10,
        body: `# Guide of ${name}\n\nBody.`,
      });
      await t.db.insert(apiSpecs).values({
        repoId: row!.id,
        path: "openapi.yaml",
        blobSha: `spec-${name}`,
        sizeBytes: 10,
        format: "openapi",
        specVersion: "3.0.0",
        title: `API of ${name}`,
        apiVersion: "1",
        operationCount: 1,
        spec: { openapi: "3.0.0", info: { title: `API of ${name}`, version: "1" }, paths: {} },
      });
    };
    await make(1, "public-own", { isPublic: true });
    await make(2, "in-public-folder", { folderId: folder!.id });
    await make(3, "plain");
    await make(4, "blocked-public", { isPublic: true, isAllowed: false });
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  const deps = (reader: typeof ANONYMOUS | typeof MEMBER) => ({ db: () => t.db, reader });
  const log = () => undefined;

  it("shows an anonymous visitor a public repository, its document and its API reference", async () => {
    const repo = await loadRepoPage("acme", "public-own", { ...deps(ANONYMOUS), log });
    expect(repo.status).toBe("ok");
    const doc = await loadDocPage("acme", "public-own", ["guide"], { ...deps(ANONYMOUS), log });
    expect(doc.status).toBe("ok");
    const api = await loadApiReference("acme", "public-own", ["openapi.yaml"], {
      ...deps(ANONYMOUS),
      log,
    });
    expect(api.status).toBe("ok");
  });

  it("shows the repositories of a public folder, and nothing else of the others", async () => {
    expect(
      (await loadRepoPage("acme", "in-public-folder", { ...deps(ANONYMOUS), log })).status,
    ).toBe("ok");
    for (const name of ["plain", "blocked-public"]) {
      expect((await loadRepoPage("acme", name, { ...deps(ANONYMOUS), log })).status, name).toBe(
        "not_found",
      );
      expect(
        (await loadDocPage("acme", name, ["guide"], { ...deps(ANONYMOUS), log })).status,
        name,
      ).toBe("not_found");
      expect(
        (await loadApiReference("acme", name, ["openapi.yaml"], { ...deps(ANONYMOUS), log }))
          .status,
        name,
      ).toBe("not_found");
    }
  });

  it("answers the same not_found for a repository that does not exist", async () => {
    const missing = await loadRepoPage("acme", "no-such-repo", { ...deps(ANONYMOUS), log });
    const hidden = await loadRepoPage("acme", "plain", { ...deps(ANONYMOUS), log });
    expect(hidden).toEqual(missing);
  });

  it("keeps showing a signed-in user every allowed repository, public or not", async () => {
    for (const name of ["public-own", "in-public-folder", "plain"]) {
      expect((await loadRepoPage("acme", name, { ...deps(MEMBER), log })).status, name).toBe("ok");
      expect(
        (await loadDocPage("acme", name, ["guide"], { ...deps(MEMBER), log })).status,
        name,
      ).toBe("ok");
    }
    expect((await loadRepoPage("acme", "blocked-public", { ...deps(MEMBER), log })).status).toBe(
      "not_found",
    );
    // No reader given: the signed-in default, as before this feature.
    expect((await loadRepoPage("acme", "plain", { db: () => t.db, log })).status).toBe("ok");
  });

  it("searches the public repositories only, hits and facet counts alike", async () => {
    const state = parseSearchParams({ q: "guide" });
    const anonymous = await loadSearchPage(state, { ...deps(ANONYMOUS), log });
    if (anonymous.status !== "ok") throw new Error("expected ok");
    const repos = anonymous.hits.map((h) => h.repoLabel).sort();
    expect(repos).toEqual(["acme/in-public-folder", "acme/public-own"]);
    expect(anonymous.total).toBe(2);
    expect(JSON.stringify(anonymous)).not.toContain("acme/plain");
    expect(JSON.stringify(anonymous)).not.toContain("blocked-public");

    const member = await loadSearchPage(state, { ...deps(MEMBER), log });
    if (member.status !== "ok") throw new Error("expected ok");
    expect(member.total).toBe(3);
  });
});
