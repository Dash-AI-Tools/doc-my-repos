import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfigError } from "./config/load";
import type { Db } from "./db/client";
import { apiSpecs, codeOwners, documents, repos } from "./db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "./db/test-db";
import { RENDER_FAILED_WARNING, RENDER_TRUNCATED_WARNING } from "./markdown/pipeline";
import {
  isRepoRoute,
  loadRepoPage,
  RENDER_FAILED_NOTICE,
  RENDER_TRUNCATED_NOTICE,
} from "./repo-page";

const NOW = new Date("2026-10-10T12:00:00Z");

/** A db factory that fails the test when anything asks for the database. */
function neverQueried(): Db {
  throw new Error("the database must not be queried");
}

function failingDb(error: unknown): Db {
  return {
    select() {
      throw error;
    },
  } as unknown as Db;
}

describe("isRepoRoute", () => {
  it("accepts GitHub owner and repository names", () => {
    expect(isRepoRoute("acme", "api-service")).toBe(true);
    expect(isRepoRoute("Acme_1", "my.repo_2")).toBe(true);
    expect(isRepoRoute("a", ".github")).toBe(true);
  });

  it("rejects characters GitHub does not allow", () => {
    for (const [owner, name] of [
      ["", "x"],
      ["x", ""],
      ["-acme", "x"],
      ["ac me", "x"],
      ["acme", "a b"],
      ["acme", "a%20b"],
      ["acme", "a/b"],
      ["acme", ".."],
      ["acme", "."],
      ["ac.me", "x"],
      ["acme", "x".repeat(101)],
      ["a".repeat(101), "x"],
      ["acme", "x\u0000"],
      ["acme", "x\ny"],
      ["acme", "é"],
    ] as const) {
      expect(isRepoRoute(owner, name), `${owner}/${name}`).toBe(false);
    }
  });

  it("rejects the app's reserved top-level names, in any case", () => {
    for (const owner of ["api", "API", "search", "Search", "e2e", "_next", "favicon.ico"]) {
      expect(isRepoRoute(owner, "x"), owner).toBe(false);
    }
  });
});

describe("loadRepoPage without a database", () => {
  it("answers not_found for invalid and reserved parameters without querying", async () => {
    for (const [owner, name] of [
      ["search", "x"],
      ["api", "sync"],
      ["acme", "../etc"],
      ["acme", "a%2Fb"],
      ["", ""],
    ] as const) {
      expect(await loadRepoPage(owner, name, { db: neverQueried })).toEqual({
        status: "not_found",
      });
    }
  });

  it("returns the error state for an unreachable database and logs only the kind", async () => {
    const log = vi.fn();
    const refused = Object.assign(new Error("connect to postgres://u:secret@10.1.2.3:5432/db"), {
      code: "ECONNREFUSED",
    });
    const data = await loadRepoPage("acme", "api", {
      db: () => failingDb(refused),
      now: () => NOW,
      log,
    });
    expect(data).toEqual({ status: "error", loadedAt: NOW });
    expect(log).toHaveBeenCalledWith("repo_page.load_failed", {
      reason: "database error (ECONNREFUSED)",
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|10\.1\.2\.3|postgres:/);
  });

  it("returns the error state when the configuration is unusable", async () => {
    const log = vi.fn();
    const data = await loadRepoPage("acme", "api", {
      db: () => {
        throw new ConfigError(["SYNC_SECRET: is not set"]);
      },
      now: () => NOW,
      log,
    });
    expect(data.status).toBe("error");
    expect(JSON.stringify(log.mock.calls)).not.toContain("SYNC_SECRET");
  });

  it("rethrows an unexpected error for the error boundary", async () => {
    const bug = new TypeError("x is not a function");
    await expect(loadRepoPage("acme", "api", { db: () => failingDb(bug) })).rejects.toBe(bug);
  });
});

describeDb("loadRepoPage on a real database", () => {
  let t: TestDatabase;
  const ids: Record<string, number> = {};

  async function insertRepo(
    key: string,
    githubId: number,
    values: Partial<typeof repos.$inferInsert> = {},
  ): Promise<number> {
    const [row] = await t.db
      .insert(repos)
      .values({
        githubId,
        owner: "acme",
        name: key,
        defaultBranch: "main",
        visibility: "public",
        htmlUrl: `https://github.com/acme/${key}`,
        ...values,
      })
      .returning({ id: repos.id });
    if (row === undefined) throw new Error("insert failed");
    ids[key] = row.id;
    return row.id;
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    const full = await insertRepo("full", 1, {
      description: "Everything",
      docsPath: "docs",
      readmePath: "README.md",
      readmeMarkdown: [
        "---",
        "title: Not shown",
        "---",
        "",
        "# Full",
        "",
        "Read the [setup guide](docs/guides/setup.md) or the [missing](docs/nope.md).",
        "",
        "![Diagram](docs/img/arch.png)",
        "",
        "```ts",
        "const a = 1;",
        "```",
        "",
        "```mermaid",
        "graph TD",
        "  A --> B",
        "```",
        "",
        "<script>alert(1)</script>",
        "",
        "## Usage",
        "",
        "Run it.",
        "",
        "### Details",
        "",
        "More.",
        "",
      ].join("\n"),
      readmeSha: "sha",
      codeownersPath: ".github/CODEOWNERS",
      syncStatus: "ok",
      lastSyncedAt: new Date("2026-10-01T00:00:00Z"),
    });
    await t.db.insert(documents).values({
      repoId: full,
      path: "docs/guides/setup.md",
      title: "Setup",
      blobSha: "b1",
      sizeBytes: 5,
      body: "# Setup",
    });
    await t.db.insert(codeOwners).values([
      {
        repoId: full,
        position: 0,
        pattern: "*",
        owners: [{ handle: "@alice", kind: "user" }],
        sourcePath: ".github/CODEOWNERS",
      },
      {
        repoId: full,
        position: 1,
        pattern: "/docs/",
        owners: [{ handle: "@my-org/docs-team", kind: "team" }],
        sourcePath: ".github/CODEOWNERS",
      },
    ]);
    const specRow = (path: string, title: string) => ({
      repoId: full,
      path,
      blobSha: `sha-${path}`,
      sizeBytes: 9,
      format: "openapi" as const,
      specVersion: "3.1.0",
      title,
      apiVersion: "2.0",
      operationCount: 3,
      spec: { openapi: "3.1.0", info: { title, version: "2.0" }, paths: {} },
    });
    await t.db
      .insert(apiSpecs)
      .values([specRow("openapi.yaml", "Zed"), specRow("api/a.yaml", "Alpha")]);
    await insertRepo("bare", 2, { description: null });
    await insertRepo("secret", 3, {
      visibility: "private",
      readmePath: "README.md",
      readmeMarkdown: "# Secret",
    });
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  const load = (owner: string, name: string, deps = {}) =>
    loadRepoPage(owner, name, { db: () => t.db, now: () => NOW, ...deps });

  it("returns the API spec summaries ordered by path, none for a repository without", async () => {
    const data = await load("acme", "full");
    if (data.status !== "ok") throw new Error("expected ok");
    expect(data.apiSpecs.map((x) => [x.path, x.title, x.apiVersion, x.operationCount])).toEqual([
      ["api/a.yaml", "Alpha", "2.0", 3],
      ["openapi.yaml", "Zed", "2.0", 3],
    ]);
    expect(data.apiSpecs[0]).not.toHaveProperty("spec");
    const bare = await load("acme", "bare");
    if (bare.status !== "ok") throw new Error("expected ok");
    expect(bare.apiSpecs).toEqual([]);
  });

  it("returns the repository, its code owners and a rendered README", async () => {
    const data = await load("acme", "full");
    expect(data.status).toBe("ok");
    if (data.status !== "ok") return;
    expect(data.loadedAt).toEqual(NOW);
    expect(data.repo).toMatchObject({
      owner: "acme",
      name: "full",
      htmlUrl: "https://github.com/acme/full",
      docCount: 1,
    });
    expect(data.repo.codeOwners.map((r) => [r.pattern, r.owners[0]?.handle])).toEqual([
      ["*", "@alice"],
      ["/docs/", "@my-org/docs-team"],
    ]);
    // the docs table of contents: folder "guides" holding "Setup"
    expect(data.tree.path).toBe("docs");
    expect(data.tree.children).toMatchObject([
      { kind: "folder", name: "guides", children: [{ kind: "doc", title: "Setup" }] },
    ]);
    expect(data.readme.status).toBe("rendered");
    if (data.readme.status !== "rendered") return;
    expect(data.readme.notice).toBeUndefined();
    const html = data.readme.html;
    // frontmatter handled by the pipeline, heading with an anchor
    expect(html).not.toContain("Not shown");
    expect(html).toMatch(/<h1 id="full">Full/);
    // relative link to a synced doc is rewritten to the in-app page
    expect(html).toContain('href="/acme/full/docs/guides/setup"');
    // link to a doc that is not synced is marked broken, without an href
    expect(html).toMatch(/<a class="dmr-broken-link"[^>]*>missing<\/a>/);
    // image goes through the proxy
    expect(html).toContain('src="/api/asset/acme/full/docs/img/arch.png"');
    // code is highlighted, the diagram is left for the client
    expect(html).toContain("shiki");
    expect(html).toContain("dmr-mermaid");
    // output is sanitized
    expect(html).not.toContain("<script");
  });

  it("lists the README's h2 to h4 headings as an outline whose ids are in the HTML", async () => {
    const data = await load("acme", "full");
    if (data.status !== "ok" || data.readme.status !== "rendered") throw new Error("expected ok");
    expect(data.readmeOutline).toEqual([
      {
        text: "Usage",
        id: "usage",
        depth: 2,
        children: [{ text: "Details", id: "details", depth: 3, children: [] }],
      },
    ]);
    for (const id of ["usage", "details"]) expect(data.readme.html).toContain(`id="${id}"`);
  });

  it("has no outline for a README with no h2 to h4 headings", async () => {
    const data = await load("acme", "full", {
      render: () =>
        Promise.resolve({
          html: "<h1>x</h1>",
          headings: [{ depth: 1, text: "x", slug: "x" }],
          warnings: [],
        }),
    });
    if (data.status !== "ok") throw new Error("expected ok");
    expect(data.readmeOutline).toEqual([]);
  });

  it("returns a missing README as such, and an empty code owners list", async () => {
    const data = await load("acme", "bare");
    expect(data.status).toBe("ok");
    if (data.status !== "ok") return;
    expect(data.readme).toEqual({ status: "missing" });
    expect(data.readmeOutline).toEqual([]);
    // no docs folder: an empty table of contents
    expect(data.tree.children).toEqual([]);
    expect(data.repo.codeOwners).toEqual([]);
    expect(data.repo.description).toBeNull();
  });

  it("looks the repository up case-insensitively and returns the stored spelling", async () => {
    const data = await load("ACME", "FULL");
    expect(data.status).toBe("ok");
    if (data.status !== "ok") return;
    expect(data.repo.owner).toBe("acme");
    expect(data.repo.name).toBe("full");
  });

  it("shows private repositories too (MVP: every synced repository is visible)", async () => {
    const data = await load("acme", "secret");
    expect(data.status).toBe("ok");
    if (data.status !== "ok") return;
    expect(data.repo.visibility).toBe("private");
  });

  it("answers not_found for an unknown repository", async () => {
    expect(await load("acme", "nope")).toEqual({ status: "not_found" });
    expect(await load("nobody", "full")).toEqual({ status: "not_found" });
  });

  it("falls back to plain text with a notice when the renderer throws", async () => {
    const log = vi.fn();
    const data = await load("acme", "full", {
      render: () => Promise.reject(new Error("boom <script>")),
      log,
    });
    expect(data.status).toBe("ok");
    if (data.status !== "ok") return;
    expect(data.readme.status).toBe("plain");
    if (data.readme.status !== "plain") return;
    expect(data.readme.notice).toBe(RENDER_FAILED_NOTICE);
    expect(data.readme.text).toContain("# Full");
    expect(data.readmeOutline).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
    // fixed text: neither the error nor the README is logged
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/boom|Full/);
  });

  it("falls back to plain text when the pipeline reports its own fallback", async () => {
    const data = await load("acme", "full", {
      render: () =>
        Promise.resolve({ html: "<pre>x</pre>", headings: [], warnings: [RENDER_FAILED_WARNING] }),
      log: () => {},
    });
    if (data.status !== "ok") throw new Error("expected ok");
    expect(data.readme).toMatchObject({ status: "plain", notice: RENDER_FAILED_NOTICE });
  });

  it("keeps the rendered HTML and adds a notice when the README was cut", async () => {
    const data = await load("acme", "full", {
      render: () =>
        Promise.resolve({ html: "<p>cut</p>", headings: [], warnings: [RENDER_TRUNCATED_WARNING] }),
    });
    if (data.status !== "ok") throw new Error("expected ok");
    expect(data.readme).toEqual({
      status: "rendered",
      html: "<p>cut</p>",
      notice: RENDER_TRUNCATED_NOTICE,
    });
  });

  it("passes the link context of the repository to the renderer", async () => {
    const render = vi.fn(() => Promise.resolve({ html: "", headings: [], warnings: [] }));
    await load("acme", "full", { render });
    const calls = render.mock.calls as unknown as [string, { links: Record<string, unknown> }][];
    const links = calls[0]?.[1].links;
    expect(links).toMatchObject({
      owner: "acme",
      repo: "full",
      defaultBranch: "main",
      docsFolder: "docs",
      path: "README.md",
    });
    expect([...(links?.docPaths as Set<string>)]).toEqual(["docs/guides/setup.md"]);
  });

  it("does not render, or read documents, when there is no README", async () => {
    const render = vi.fn();
    await load("acme", "bare", { render });
    expect(render).not.toHaveBeenCalled();
  });
});
