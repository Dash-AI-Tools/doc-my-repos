import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfigError } from "./config/load";
import type { Db } from "./db/client";
import { documents, repos } from "./db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "./db/test-db";
import {
  DOC_RENDER_FAILED_NOTICE,
  DOC_RENDER_TRUNCATED_NOTICE,
  loadDocPage,
  type DocPageData,
  type DocPageOk,
} from "./doc-page";
import { RENDER_FAILED_WARNING, RENDER_TRUNCATED_WARNING } from "./markdown/pipeline";

const NOW = new Date("2026-10-10T12:00:00Z");

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

function expectOk(data: DocPageData): DocPageOk {
  if (data.status !== "ok") throw new Error(`expected ok, got ${data.status}`);
  return data;
}

describe("loadDocPage without a database", () => {
  it("answers not_found for invalid, reserved and empty parameters without querying", async () => {
    for (const [owner, name, segments] of [
      ["search", "x", ["a"]],
      ["api", "sync", ["a"]],
      ["acme", "../etc", ["a"]],
      ["acme", "a%2Fb", ["a"]],
      ["acme", "api", []],
    ] as const) {
      expect(await loadDocPage(owner, name, segments, { db: neverQueried })).toEqual({
        status: "not_found",
      });
    }
  });

  it("returns the error state for an unreachable database and logs only the kind", async () => {
    const log = vi.fn();
    const refused = Object.assign(new Error("connect to postgres://u:secret@10.1.2.3:5432/db"), {
      code: "ECONNREFUSED",
    });
    const data = await loadDocPage("acme", "api", ["a"], {
      db: () => failingDb(refused),
      now: () => NOW,
      log,
    });
    expect(data).toEqual({ status: "error", loadedAt: NOW });
    expect(log).toHaveBeenCalledWith("doc_page.load_failed", {
      reason: "database error (ECONNREFUSED)",
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|10\.1\.2\.3|postgres:/);
  });

  it("returns the error state when the configuration is unusable", async () => {
    const data = await loadDocPage("acme", "api", ["a"], {
      db: () => {
        throw new ConfigError(["SYNC_SECRET: is not set"]);
      },
      now: () => NOW,
      log: () => {},
    });
    expect(data.status).toBe("error");
  });

  it("rethrows an unexpected error for the error boundary", async () => {
    const bug = new TypeError("x is not a function");
    await expect(loadDocPage("acme", "api", ["a"], { db: () => failingDb(bug) })).rejects.toBe(bug);
  });
});

describeDb("loadDocPage on a real database", () => {
  let t: TestDatabase;

  async function insertRepo(
    name: string,
    githubId: number,
    values: Partial<typeof repos.$inferInsert> = {},
  ): Promise<number> {
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
        ...values,
      })
      .returning({ id: repos.id });
    if (row === undefined) throw new Error("insert failed");
    return row.id;
  }

  async function insertDoc(
    repoId: number,
    path: string,
    title: string,
    body: string,
    extra: Partial<typeof documents.$inferInsert> = {},
  ): Promise<void> {
    await t.db.insert(documents).values({
      repoId,
      path,
      title,
      blobSha: `sha-${path}`,
      sizeBytes: body.length,
      body,
      ...extra,
    });
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    const full = await insertRepo("full", 1, { description: "Everything" });
    await insertDoc(full, "docs/index.md", "Home", "# Home\n\nWelcome.", { reserved: "index" });
    await insertDoc(full, "docs/guides/index.md", "Guides", "# Guides\n\nAll guides.", {
      reserved: "index",
      description: "How-to guides.",
    });
    await insertDoc(
      full,
      "docs/guides/setup.md",
      "Setup",
      [
        "# Setup",
        "",
        "Intro, see [tuning](advanced/tuning.md) and [missing](nope.md).",
        "",
        "## Install",
        "",
        "```ts",
        "const a = 1;",
        "```",
        "",
        "### Linux",
        "",
        "## Use",
        "",
        "![Diagram](../img/arch.png)",
        "",
        "<script>alert(1)</script>",
        "",
      ].join("\n"),
      { description: "How to set up.", type: "Guide", tags: ["a", "b"], status: "active" },
    );
    await insertDoc(full, "docs/guides/advanced/tuning.md", "Tuning", "## Pool\n\nBigger.\n");
    await insertDoc(full, "docs/reference/api.md", "API", "# Different heading\n\nText.");
    await insertDoc(full, "docs/UPPER.MD", "Upper", "# Upper");
    await insertDoc(full, "docs/100% done.md", "100% done", "# 100% done");
    await insertDoc(full, "docs/zeta/last.md", "Last", "# Last");
    await insertDoc(full, "README-outside.md", "Outside", "# Outside");
    await insertRepo("bare", 2, { docsPath: null, lastSyncedAt: null, syncStatus: "pending" });
    const secret = await insertRepo("secret", 3, { visibility: "private" });
    await insertDoc(secret, "docs/a.md", "A", "# A");
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  const load = (owner: string, name: string, segments: readonly string[], deps = {}) =>
    loadDocPage(owner, name, segments, { db: () => t.db, now: () => NOW, ...deps });

  describe("found", () => {
    it("returns the document, its rendered body and the link context of the repository", async () => {
      const data = expectOk(await load("acme", "full", ["guides", "setup"]));
      expect(data.loadedAt).toEqual(NOW);
      expect(data.url).toBe("/acme/full/docs/guides/setup");
      expect(data.repo).toMatchObject({ owner: "acme", name: "full", docsPath: "docs" });
      expect(data.doc).toMatchObject({
        path: "docs/guides/setup.md",
        title: "Setup",
        description: "How to set up.",
        type: "Guide",
        tags: ["a", "b"],
        status: "active",
      });
      // the body is rendered into `body`, not kept on `doc`
      expect("body" in data.doc).toBe(false);
      expect(data.body.status).toBe("rendered");
      if (data.body.status !== "rendered") return;
      const html = data.body.html;
      expect(html).toContain('href="/acme/full/docs/guides/advanced/tuning"');
      expect(html).toMatch(/<a class="dmr-broken-link"[^>]*>missing<\/a>/);
      expect(html).toContain('src="/api/asset/acme/full/docs/img/arch.png"');
      expect(html).toContain("shiki");
      expect(html).not.toContain("<script");
      expect(data.notice).toBeNull();
    });

    it("hides the body's first h1 only when it repeats the title", async () => {
      const same = expectOk(await load("acme", "full", ["guides", "setup"]));
      expect(same.body).toMatchObject({ status: "rendered", hideTitleHeading: true });
      const different = expectOk(await load("acme", "full", ["reference", "api"]));
      expect(different.body).toMatchObject({ status: "rendered", hideTitleHeading: false });
      const none = expectOk(await load("acme", "full", ["guides", "advanced", "tuning"]));
      expect(none.body).toMatchObject({ status: "rendered", hideTitleHeading: false });
    });

    it("builds the outline from the render result: h2 to h4, nested, linked by id", async () => {
      const data = expectOk(await load("acme", "full", ["guides", "setup"]));
      expect(data.outline).toEqual([
        {
          text: "Install",
          id: "install",
          depth: 2,
          children: [{ text: "Linux", id: "linux", depth: 3, children: [] }],
        },
        { text: "Use", id: "use", depth: 2, children: [] },
      ]);
      expect(data.body.status === "rendered" && data.body.html).toContain('id="install"');
    });

    it("links previous and next in table-of-contents order", async () => {
      // order: Home (root index), 100% done, Upper, then folders: Guides (index), Setup, Tuning,
      // API, Last
      const middle = expectOk(await load("acme", "full", ["guides", "setup"]));
      expect(middle.previous?.title).toBe("Guides");
      expect(middle.next?.title).toBe("Tuning");
      const first = expectOk(await load("acme", "full", ["index"]));
      expect(first.previous).toBeNull();
      expect(first.next?.title).toBe("100% done");
      const last = expectOk(await load("acme", "full", ["zeta", "last"]));
      expect(last.next).toBeNull();
      expect(last.previous?.title).toBe("API");
    });

    it("returns the whole table of contents and the folders above the document", async () => {
      const data = expectOk(await load("acme", "full", ["guides", "advanced", "tuning"]));
      expect(data.tree.children.map((c) => (c.kind === "doc" ? c.title : `${c.name}/`))).toEqual([
        "100% done",
        "Upper",
        "guides/",
        "reference/",
        "zeta/",
      ]);
      expect(data.crumbs).toEqual([
        { label: "guides", href: "/acme/full/docs/guides/index" },
        { label: "advanced", href: null },
      ]);
    });

    it("links the source file on GitHub", async () => {
      const data = expectOk(await load("acme", "full", ["guides", "setup"]));
      expect(data.sourceUrl).toBe("https://github.com/acme/full/blob/main/docs/guides/setup.md");
      const odd = expectOk(await load("acme", "full", ["100% done"]));
      expect(odd.sourceUrl).toBe("https://github.com/acme/full/blob/main/docs/100%25%20done.md");
    });

    it("serves index.md as an ordinary page at .../index", async () => {
      const data = expectOk(await load("acme", "full", ["guides", "index"]));
      expect(data.doc.reserved).toBe("index");
      expect(data.doc.title).toBe("Guides");
      expect(data.url).toBe("/acme/full/docs/guides/index");
    });

    it("shows documents of private repositories too (MVP: every synced repository is visible)", async () => {
      expectOk(await load("acme", "secret", ["a"]));
    });

    it("finds a file with an upper-case extension and uses the extension-less address", async () => {
      const data = expectOk(await load("acme", "full", ["UPPER"]));
      expect(data.doc.path).toBe("docs/UPPER.MD");
      expect(data.url).toBe("/acme/full/docs/UPPER");
    });
  });

  describe("redirects to the canonical address", () => {
    it("for another case of the owner and repository", async () => {
      expect(await load("ACME", "FULL", ["guides", "setup"])).toEqual({
        status: "redirect",
        to: "/acme/full/docs/guides/setup",
      });
    });

    it("for another case of the document path", async () => {
      expect(await load("acme", "full", ["Guides", "SETUP"])).toEqual({
        status: "redirect",
        to: "/acme/full/docs/guides/setup",
      });
    });

    it("from a folder to its index", async () => {
      expect(await load("acme", "full", ["guides"])).toEqual({
        status: "redirect",
        to: "/acme/full/docs/guides/index",
      });
      expect(await load("acme", "full", ["GUIDES"])).toEqual({
        status: "redirect",
        to: "/acme/full/docs/guides/index",
      });
    });
  });

  describe("not found", () => {
    it("for a missing document, a folder without an index and a file extension in the address", async () => {
      for (const segments of [["nope"], ["guides", "nope"], ["reference"], ["zeta"], ["a.md"]]) {
        expect(await load("acme", "full", segments), segments.join("/")).toEqual({
          status: "not_found",
        });
      }
    });

    it("for hostile segments", async () => {
      for (const segments of [
        [".."],
        ["..", "x"],
        ["."],
        ["a/b"],
        ["a\\b"],
        ["a\u0000"],
        [""],
        ["guides", "..", "..", "etc"],
        ["x".repeat(5000)],
      ]) {
        expect(await load("acme", "full", segments), JSON.stringify(segments)).toEqual({
          status: "not_found",
        });
      }
    });

    it("for an unknown repository", async () => {
      expect(await load("acme", "nope", ["a"])).toEqual({ status: "not_found" });
      expect(await load("nobody", "full", ["a"])).toEqual({ status: "not_found" });
    });

    it("for a repository without a docs folder", async () => {
      expect(await load("acme", "bare", ["a"])).toEqual({ status: "not_found" });
    });

    it("for a file outside the docs folder", async () => {
      expect(await load("acme", "full", ["README-outside"])).toEqual({ status: "not_found" });
    });
  });

  describe("render fallback", () => {
    it("shows plain text with a notice, and no outline, when the renderer throws", async () => {
      const log = vi.fn();
      const data = expectOk(
        await load("acme", "full", ["guides", "setup"], {
          render: () => Promise.reject(new Error("boom <script>")),
          log,
        }),
      );
      expect(data.body.status).toBe("plain");
      if (data.body.status !== "plain") return;
      expect(data.body.text).toContain("# Setup");
      expect(data.notice).toBe(DOC_RENDER_FAILED_NOTICE);
      expect(data.outline).toEqual([]);
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/boom|Setup/);
    });

    it("shows plain text when the pipeline reports its own fallback", async () => {
      const data = expectOk(
        await load("acme", "full", ["guides", "setup"], {
          render: () =>
            Promise.resolve({
              html: "<pre>x</pre>",
              headings: [],
              warnings: [RENDER_FAILED_WARNING],
            }),
          log: () => {},
        }),
      );
      expect(data.body.status).toBe("plain");
      expect(data.notice).toBe(DOC_RENDER_FAILED_NOTICE);
    });

    it("keeps the rendered HTML and adds a notice when the document was cut", async () => {
      const data = expectOk(
        await load("acme", "full", ["guides", "setup"], {
          render: () =>
            Promise.resolve({
              html: "<p>cut</p>",
              headings: [],
              warnings: [RENDER_TRUNCATED_WARNING],
            }),
        }),
      );
      expect(data.body).toEqual({
        status: "rendered",
        html: "<p>cut</p>",
        hideTitleHeading: false,
      });
      expect(data.notice).toBe(DOC_RENDER_TRUNCATED_NOTICE);
    });

    it("passes the link context of the document to the renderer", async () => {
      const render = vi.fn(() => Promise.resolve({ html: "", headings: [], warnings: [] }));
      await load("acme", "full", ["guides", "setup"], { render });
      const calls = render.mock.calls as unknown as [string, { links: Record<string, unknown> }][];
      const links = calls[0]?.[1].links;
      expect(links).toMatchObject({
        owner: "acme",
        repo: "full",
        defaultBranch: "main",
        docsFolder: "docs",
        path: "docs/guides/setup.md",
      });
      expect([...(links?.docPaths as Set<string>)].sort()).toEqual(
        [
          "README-outside.md",
          "docs/100% done.md",
          "docs/UPPER.MD",
          "docs/guides/advanced/tuning.md",
          "docs/guides/index.md",
          "docs/guides/setup.md",
          "docs/index.md",
          "docs/reference/api.md",
          "docs/zeta/last.md",
        ].sort(),
      );
    });
  });
});
