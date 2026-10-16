import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  adjacentInTree,
  buildDocsTree,
  flattenDocsTree,
  type DocsTreeFolder,
  type DocsTreeRow,
} from "@/lib/docs-tree";
import {
  MAX_DEPTH as OKF_MAX_DEPTH,
  MAX_UNKNOWN,
  buildNotices,
  buildOkfMeta,
  parseOkfDate,
  safeExternalUrl,
  staleness,
} from "@/lib/okf-meta";
import { PALETTE_DEFAULT_LIMIT, PALETTE_MAX_LIMIT } from "@/lib/palette";
import { docUrl } from "@/lib/routes";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_QUERY_CHARS,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_OFFSET,
} from "@/lib/search";

import { ASSET_MAX_AGE_SECONDS, ASSET_TIMEOUT_MS, MAX_ASSET_BYTES } from "../assets/serve";
import { DEFAULT_ASSET_CACHE_BYTES } from "../assets/cache";
import { DEFAULT_FETCH_CONCURRENCY, DEFAULT_FETCH_QUEUE } from "../assets/fetch-gate";
import {
  DEFAULT_MAX_DOCS_PER_REPO,
  DEFAULT_SYNC_INTERVAL_MINUTES,
  MAX_DOCS_PER_REPO_LIMIT,
  MAX_SYNC_INTERVAL_MINUTES,
  MIN_FILE_BYTES_LIMIT,
  MIN_SYNC_INTERVAL_MINUTES,
  configSchema,
} from "../config/schema";
import { MIN_SECRET_LENGTH } from "../config/secret";
import { createDb, type DbHandle } from "../db/client";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { createGitHubClient } from "../github/client";
import { rehypeHighlight } from "../markdown/highlight";
import { resolveImage } from "../markdown/images";
import { createLinkResolver, type LinkContext } from "../markdown/links";
import { MAX_DIAGRAMS, MAX_SOURCE_BYTES } from "../markdown/mermaid";
import { renderMarkdown } from "../markdown/pipeline";
import { anchorId } from "../markdown/sanitize";
import { imageTypeForPath, sniffImageType } from "../assets/image-types";
import {
  getDocPaths,
  getDocsTree,
  getDocumentByPath,
  getRepo,
  getRepoFacets,
  searchDocuments,
  searchFacets,
} from "../queries";
import { MAX_STATUS_REPOS } from "../queries/status";
import { RANK_WEIGHTS } from "../queries/search";
import { MAX_IN_FLIGHT as SEARCH_IN_FLIGHT } from "../search-api";
import { MAX_IN_FLIGHT as STATUS_IN_FLIGHT, handleStatusRequest } from "../status-api";
import { DEFAULT_BLOB_CONCURRENCY, DEFAULT_MAX_TOTAL_BYTES } from "../sync/blobs";
import { buildDocumentRecord, MAX_FACET_CHARS, MAX_TAGS } from "../sync/document-record";
import { DEFAULT_MAX_PASSES, createSyncContext, syncAll, type SyncContext } from "../sync/engine";
import { FakeGitHub } from "../sync/fake-github";
import { MAX_BODY_BYTES as SYNC_BODY_BYTES } from "../sync/manual-sync";
import { DEFAULT_STALE_GRACE_MS } from "../sync/runs";
import {
  DEFAULT_DRAIN_INTERVAL_MS,
  DEFAULT_JITTER,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_STARTUP_DELAY_MS,
} from "../sync/scheduler";
import { DEFAULT_MAX_FILE_BYTES } from "../sync/tree";
import { DEFAULT_DISPATCH_WAIT_MS, MAX_WEBHOOK_BODY_BYTES } from "../webhooks/endpoint";
import { MAX_INDIVIDUAL_ADDED } from "../webhooks/router";
import { WEBHOOK_REMOVAL_LOCK_WAIT_MS } from "../webhooks/service";
import { MAX_DESCRIPTION_CHARS, MAX_TITLE_CHARS, extractMetadata } from "./extract";
import {
  MAX_FRONTMATTER_BYTES,
  MAX_FRONTMATTER_DEPTH,
  MAX_FRONTMATTER_NODES,
  parseFrontmatter,
  type FrontmatterData,
} from "./frontmatter";

/**
 * Dogfood check (task 13.5, deployment spec "Dogfooded documentation"): the real `docs/` folder
 * of this repository is loaded from the working tree as the tree of a fake GitHub repository,
 * synced end to end with the real engine into a real test database, and read back through the
 * shared query layer, the link resolver and the markdown pipeline. A real sync against GitHub
 * needs a GitHub App and a human; everything after the GitHub API boundary is the production code.
 *
 * The first block needs no database (links, images, frontmatter conventions, size caps, documented
 * limits). The second block syncs and reads back.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OWNER = "acme";
const REPO = "doc-my-repos";
const REPO_ID = 777;
const BRANCH = "main";

// ---------------------------------------------------------------------------------------------
// The files of the working tree

interface DiskFile {
  /** Repo-relative path with `/` separators. */
  readonly path: string;
  readonly bytes: Buffer;
}

function walk(dir: string, prefix: string, out: DiskFile[]): void {
  for (const entry of readdirSync(join(dir), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(join(dir, entry.name), path, out);
    else if (entry.isFile()) out.push({ path, bytes: readFileSync(join(dir, entry.name)) });
  }
}

const DOCS_FILES: DiskFile[] = [];
walk(join(ROOT, "docs"), "docs", DOCS_FILES);
DOCS_FILES.sort((a, b) => (a.path < b.path ? -1 : 1));

const MARKDOWN = DOCS_FILES.filter((f) => /\.md$/i.test(f.path));
const textOf = (file: DiskFile): string => file.bytes.toString("utf8");
const MARKDOWN_PATHS = new Set(MARKDOWN.map((f) => f.path));
const README = readFileSync(join(ROOT, "README.md"), "utf8");

/** What the fake repository holds: the real docs folder plus the real README. */
function repoFiles(): Record<string, string | Uint8Array> {
  const files: Record<string, string | Uint8Array> = { "README.md": README };
  for (const file of DOCS_FILES) {
    files[file.path] = /\.(md|json)$/i.test(file.path) ? textOf(file) : new Uint8Array(file.bytes);
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// What the bundle is meant to look like

/** Every concept document and its `type`. A new document must be added here on purpose. */
const EXPECTED_TYPES: Readonly<Record<string, string>> = {
  "docs/architecture/data-model.md": "Concept",
  "docs/architecture/overview.md": "Concept",
  "docs/architecture/security.md": "Concept",
  "docs/architecture/sync-engine.md": "Concept",
  "docs/decisions/0001-postgres-fts-simple.md": "Decision",
  "docs/decisions/0002-advisory-locks-no-queue.md": "Decision",
  "docs/decisions/0003-store-parsed-documents.md": "Decision",
  "docs/decisions/0004-mermaid-client-side.md": "Decision",
  "docs/github-app-setup.md": "Guide",
  "docs/guides/ask.md": "Guide",
  "docs/guides/comments.md": "Guide",
  "docs/guides/configuration.md": "Guide",
  "docs/guides/getting-started.md": "Guide",
  "docs/guides/okf-support.md": "Guide",
  "docs/guides/search.md": "Guide",
  "docs/guides/webhooks.md": "Guide",
  "docs/reference/api.md": "Reference",
  "docs/reference/frontmatter.md": "Reference",
  "docs/reference/operations.md": "Runbook",
};

const RESERVED_PATHS = [
  "docs/architecture/index.md",
  "docs/decisions/index.md",
  "docs/guides/index.md",
  "docs/index.md",
  "docs/log.md",
  "docs/reference/index.md",
];

const FOLDERS = ["architecture", "decisions", "guides", "reference"];

// ---------------------------------------------------------------------------------------------
// Markdown helpers

function parseMarkdown(markdown: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(markdown);
}

interface Collected {
  links: string[];
  images: { url: string; alt: string }[];
  fences: { lang: string | null }[];
}

function collect(markdown: string): Collected {
  const out: Collected = { links: [], images: [], fences: [] };
  const stack: RootContent[] = [...parseMarkdown(markdown).children].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.type === "link") out.links.push(node.url);
    else if (node.type === "image") out.images.push({ url: node.url, alt: node.alt ?? "" });
    else if (node.type === "code") out.fences.push({ lang: node.lang ?? null });
    if ("children" in node) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i] as RootContent);
      }
    }
  }
  return out;
}

function bodyOf(file: DiskFile): string {
  return parseFrontmatter(textOf(file)).body;
}

function frontmatterOf(file: DiskFile): FrontmatterData {
  return parseFrontmatter(textOf(file)).frontmatter;
}

function contextFor(path: string, docPaths: ReadonlySet<string>): LinkContext {
  return {
    owner: OWNER,
    repo: REPO,
    defaultBranch: BRANCH,
    docsFolder: "docs",
    path,
    docPaths,
  };
}

/** Stored-form headings of a document on disk (what the sync stores). */
function headingsOf(path: string) {
  const file = MARKDOWN.find((f) => f.path === path);
  if (file === undefined) throw new Error(`no such document ${path}`);
  const parsed = parseFrontmatter(textOf(file));
  return extractMetadata({ body: parsed.body, frontmatter: parsed.frontmatter, path }).headings;
}

function decodeFragment(fragment: string): string {
  return decodeURIComponent(fragment);
}

// ---------------------------------------------------------------------------------------------
// Block 1: the files themselves (no database)

describe("dogfood docs: the files", () => {
  it("has the planned documents, folders and reserved files", () => {
    const concepts = MARKDOWN.filter((f) => !RESERVED_PATHS.includes(f.path)).map((f) => f.path);
    expect(concepts).toEqual(Object.keys(EXPECTED_TYPES).sort());
    for (const path of RESERVED_PATHS) expect(MARKDOWN_PATHS.has(path), path).toBe(true);
    // The two non-Markdown files the docs link to stay valid.
    const manifest = JSON.parse(
      textOf(DOCS_FILES.find((f) => f.path === "docs/github-app-manifest.json") as DiskFile),
    ) as { default_permissions: Record<string, string>; default_events: string[] };
    expect(Object.values(manifest.default_permissions).every((v) => v === "read")).toBe(true);
    expect(manifest.default_events).toEqual(expect.arrayContaining(["push", "repository"]));
  });

  it("gives every concept a type from the bundle's small set and useful frontmatter", () => {
    for (const file of MARKDOWN) {
      const parsed = parseFrontmatter(textOf(file));
      expect(parsed.warnings, file.path).toEqual([]);
      const fm = parsed.frontmatter;
      if (RESERVED_PATHS.includes(file.path)) {
        expect(Object.hasOwn(fm, "type"), `${file.path} is reserved and carries no type`).toBe(
          false,
        );
        expect(typeof fm.description === "string" && fm.description.length > 20, file.path).toBe(
          true,
        );
        continue;
      }
      expect(fm.type, file.path).toBe(EXPECTED_TYPES[file.path]);
      for (const key of ["title", "description"] as const) {
        expect(
          typeof fm[key] === "string" && (fm[key] as string).length > 4,
          `${file.path} ${key}`,
        ).toBe(true);
      }
      expect(Array.isArray(fm.tags) && fm.tags.length > 0, `${file.path} tags`).toBe(true);
      expect(typeof fm.status === "string", `${file.path} status`).toBe(true);
      expect(parseOkfDate(fm.generated)?.valid, `${file.path} generated`).toBe(true);
    }
  });

  it("declares okf_version only in the docs-root index", () => {
    for (const file of MARKDOWN) {
      const has = Object.hasOwn(frontmatterOf(file), "okf_version");
      expect(has, file.path).toBe(file.path === "docs/index.md");
    }
    expect(
      frontmatterOf(MARKDOWN.find((f) => f.path === "docs/index.md") as DiskFile).okf_version,
    ).toBe("0.2");
  });

  it("points `sources` at files that exist and `resource` at safe URLs", () => {
    let checked = 0;
    for (const file of MARKDOWN) {
      const fm = frontmatterOf(file);
      if (Array.isArray(fm.sources)) {
        for (const source of fm.sources) {
          expect(typeof source, file.path).toBe("string");
          expect(
            existsSync(join(ROOT, source as string)),
            `${file.path} source ${String(source)}`,
          ).toBe(true);
          checked++;
        }
      }
      if (typeof fm.resource === "string") {
        expect(safeExternalUrl(fm.resource), `${file.path} resource`).not.toBeNull();
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("keeps every document far below the size caps", () => {
    expect(MARKDOWN.length).toBeLessThan(DEFAULT_MAX_DOCS_PER_REPO);
    for (const file of DOCS_FILES) {
      expect(file.bytes.length, file.path).toBeLessThan(DEFAULT_MAX_FILE_BYTES / 4);
    }
    const total = MARKDOWN.reduce((sum, f) => sum + f.bytes.length, 0);
    expect(total).toBeLessThan(1024 * 1024);
  });

  it("builds a stored record for every document without warnings", () => {
    for (const file of MARKDOWN) {
      const built = buildDocumentRecord(file.path, textOf(file), { docsFolder: "docs" });
      expect(built.ok, file.path).toBe(true);
      if (!built.ok) continue;
      expect(built.warnings, file.path).toEqual([]);
      expect(built.record.title.length, file.path).toBeGreaterThan(2);
      expect(built.record.type, file.path).toBe(EXPECTED_TYPES[file.path] ?? null);
    }
  });

  it("resolves every link: documents, source files, anchors and external URLs", () => {
    const counts = { doc: 0, github: 0, fragment: 0, external: 0 };
    for (const file of MARKDOWN) {
      const resolve = createLinkResolver(contextFor(file.path, MARKDOWN_PATHS));
      const own = new Set(headingsOf(file.path).map((h) => h.slug));
      for (const url of collect(bodyOf(file)).links) {
        const resolution = resolve(url);
        const where = `${file.path}: ${url}`;
        if (resolution.kind === "broken") {
          throw new Error(`broken link in ${where} (${resolution.reason})`);
        }
        if (resolution.kind === "untouched") {
          if (url.startsWith("#")) {
            expect(own.has(decodeFragment(url.slice(1)).toLowerCase()), `anchor ${where}`).toBe(
              true,
            );
            counts.fragment++;
          } else {
            // External links are https, or a loopback address in a local-run example.
            expect(url, where).toMatch(
              /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])[^\s]+$/,
            );
            counts.external++;
          }
          continue;
        }
        if (resolution.kind === "doc") {
          const [stemPart = "", hash] = resolution.href.split("#");
          const prefix = `/${OWNER}/${REPO}/docs/`;
          expect(stemPart.startsWith(prefix), where).toBe(true);
          const stem = stemPart
            .slice(prefix.length)
            .split("/")
            .map((s) => decodeURIComponent(s))
            .join("/");
          const target = `docs/${stem}.md`;
          expect(MARKDOWN_PATHS.has(target), `target ${target} of ${where}`).toBe(true);
          expect(docUrl(OWNER, REPO, target, "docs"), where).toBe(stemPart);
          if (hash !== undefined) {
            const anchors = new Set(headingsOf(target).map((h) => anchorId(h.slug)));
            expect(anchors.has(decodeFragment(hash)), `anchor of ${where} in ${target}`).toBe(true);
          }
          counts.doc++;
          continue;
        }
        // A file or folder outside the synced documents: it must exist in the working tree.
        const match =
          /^https:\/\/github\.com\/acme\/doc-my-repos\/(?:blob|tree)\/main\/(.+?)(?:#.*)?$/.exec(
            resolution.href,
          );
        expect(match, where).not.toBeNull();
        const path = (match?.[1] ?? "")
          .split("/")
          .map((s) => decodeURIComponent(s))
          .join("/");
        expect(existsSync(join(ROOT, path)), `repository file ${path} linked from ${where}`).toBe(
          true,
        );
        counts.github++;
      }
    }
    // Guard against a vacuous pass.
    expect(counts.doc).toBeGreaterThan(60);
    expect(counts.github).toBeGreaterThan(3);
    expect(counts.fragment).toBeGreaterThan(0);
    expect(counts.external).toBeGreaterThan(3);
  });

  it("resolves every image through the proxy to a real image of the claimed type", () => {
    let images = 0;
    for (const file of MARKDOWN) {
      const ctx = contextFor(file.path, MARKDOWN_PATHS);
      for (const image of collect(bodyOf(file)).images) {
        const resolved = resolveImage(image.url, ctx);
        expect(resolved.kind, `${file.path}: ${image.url}`).toBe("asset");
        if (resolved.kind !== "asset") continue;
        expect(image.alt.length, `${file.path} alt text`).toBeGreaterThan(5);
        expect(resolved.src.startsWith(`/api/asset/${OWNER}/${REPO}/docs/images/`)).toBe(true);
        const onDisk = DOCS_FILES.find((f) => f.path === resolved.path);
        expect(onDisk, resolved.path).toBeDefined();
        const claimed = imageTypeForPath(resolved.path);
        expect(sniffImageType(new Uint8Array(onDisk?.bytes ?? [])), resolved.path).toBe(claimed);
        images++;
      }
    }
    expect(images).toBeGreaterThanOrEqual(1);
  });

  it("states the limits the code enforces (a changed constant fails here until the docs follow)", () => {
    const doc = (path: string): string =>
      textOf(DOCS_FILES.find((f) => f.path === path) as DiskFile);
    const mentions = (path: string, ...needles: (string | number)[]) => {
      const text = doc(path);
      for (const needle of needles) {
        expect(text, `${path} should state ${String(needle)}`).toContain(String(needle));
      }
    };
    const mib = (bytes: number) => `${bytes / 1024 / 1024} MiB`;

    mentions(
      "docs/guides/configuration.md",
      `\`${DEFAULT_MAX_DOCS_PER_REPO}\``,
      `1 to ${MAX_DOCS_PER_REPO_LIMIT}`,
      `\`${DEFAULT_MAX_FILE_BYTES}\``,
      `${MIN_FILE_BYTES_LIMIT} to ${DEFAULT_MAX_FILE_BYTES}`,
      `\`${DEFAULT_SYNC_INTERVAL_MINUTES}\``,
      `${MIN_SYNC_INTERVAL_MINUTES} to ${MAX_SYNC_INTERVAL_MINUTES}`,
      `${MIN_SECRET_LENGTH} or more`,
    );
    mentions(
      "docs/architecture/sync-engine.md",
      `${DEFAULT_BLOB_CONCURRENCY} at a time`,
      `${mib(DEFAULT_MAX_TOTAL_BYTES)} budget`,
      `${DEFAULT_MAX_PASSES} passes`,
      DEFAULT_STALE_GRACE_MS === 60_000 ? "one-minute grace" : "?",
      `${DEFAULT_STARTUP_DELAY_MS / 1000} seconds after start`,
      `${DEFAULT_JITTER * 100} percent jitter`,
      `${DEFAULT_RETRY_BASE_MS / 60_000} minute, doubling`,
      `${DEFAULT_MAX_BACKOFF_MS / 60_000} minutes`,
      DEFAULT_DRAIN_INTERVAL_MS === 60_000 ? "every minute" : "?",
      `${DEFAULT_MAX_FILE_BYTES / 1024} KB`,
    );
    mentions(
      "docs/reference/api.md",
      `${SYNC_BODY_BYTES} bytes`,
      mib(MAX_WEBHOOK_BODY_BYTES),
      `${DEFAULT_DISPATCH_WAIT_MS / 1000} seconds`,
      `${MAX_QUERY_CHARS} characters`,
      `1 to ${PALETTE_MAX_LIMIT}, default ${PALETTE_DEFAULT_LIMIT}`,
      `more than ${SEARCH_IN_FLIGHT} searches`,
      `more than ${STATUS_IN_FLIGHT} reads`,
      `at most ${MAX_STATUS_REPOS} repositories`,
      mib(MAX_ASSET_BYTES),
      `${ASSET_TIMEOUT_MS / 1000} seconds`,
      `max-age=${ASSET_MAX_AGE_SECONDS}`,
      mib(DEFAULT_ASSET_CACHE_BYTES),
      `${DEFAULT_FETCH_CONCURRENCY} upstream fetches`,
      `${DEFAULT_FETCH_QUEUE} more queued`,
      `${MIN_SECRET_LENGTH} characters`,
    );
    mentions(
      "docs/guides/search.md",
      `${MAX_QUERY_CHARS} characters`,
      `default ${DEFAULT_SEARCH_LIMIT}`,
      `1 to ${MAX_SEARCH_LIMIT}`,
      String(MAX_SEARCH_OFFSET),
    );
    mentions("docs/architecture/data-model.md", `{${RANK_WEIGHTS.join(", ")}}`);
    mentions(
      "docs/guides/webhooks.md",
      `more than ${MAX_INDIVIDUAL_ADDED} were added`,
      `${WEBHOOK_REMOVAL_LOCK_WAIT_MS / 1000} seconds`,
      mib(MAX_WEBHOOK_BODY_BYTES),
      `${MIN_SECRET_LENGTH} characters`,
    );
    mentions(
      "docs/architecture/security.md",
      `${MAX_DIAGRAMS} diagrams`,
      `${MAX_SOURCE_BYTES / 1024} KB`,
      `${MIN_SECRET_LENGTH} characters`,
    );
    mentions(
      "docs/reference/frontmatter.md",
      `${MAX_TITLE_CHARS} characters`,
      `${MAX_DESCRIPTION_CHARS} characters`,
      `${MAX_TAGS} tags of ${MAX_FACET_CHARS} characters`,
      `${MAX_FRONTMATTER_BYTES / 1024} KiB`,
      `${MAX_FRONTMATTER_DEPTH} levels`,
      `${MAX_FRONTMATTER_NODES.toLocaleString("en-US")} values`,
      `At most ${MAX_UNKNOWN} unknown keys`,
      `after ${["zero", "one", "two", "three", "four"][OKF_MAX_DEPTH]} levels`,
    );
  });

  it("uses tables, task lists, footnotes, several code languages and at least four diagrams", () => {
    const languages = new Set<string>();
    let diagrams = 0;
    for (const file of MARKDOWN) {
      for (const fence of collect(bodyOf(file)).fences) {
        if (fence.lang === "mermaid") diagrams++;
        else if (fence.lang !== null) languages.add(fence.lang);
      }
    }
    expect(diagrams).toBeGreaterThanOrEqual(4);
    expect([...languages]).toEqual(
      expect.arrayContaining(["bash", "yaml", "json", "sql", "http", "markdown"]),
    );
    const all = MARKDOWN.map(bodyOf).join("\n");
    expect(all).toMatch(/^\| .* \|$/m);
    expect(all).toMatch(/^- \[[ x]\] /m);
    expect(all).toMatch(/^\[\^[a-z]+\]: /m);
  });
});

// ---------------------------------------------------------------------------------------------
// Block 2: sync it for real and read it back

describeDb("dogfood docs: synced end to end into a test database", () => {
  vi.setConfig({ testTimeout: 60_000 });
  let testDb: TestDatabase;
  let h: DbHandle;
  let fake: FakeGitHub;
  let ctx: SyncContext;
  let first: Awaited<ReturnType<typeof syncAll>>;
  let firstBlobRequests = 0;
  let rows: DocsTreeRow[] = [];
  let tree: DocsTreeFolder;
  let docPaths: Set<string>;

  const ref = { id: 0 };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    h = createDb(testDb.url.reveal(), { max: 10 });
    fake = new FakeGitHub({
      owner: OWNER,
      repos: [
        {
          id: REPO_ID,
          name: REPO,
          description: "Docs of DocMyRepos, synced into itself",
          files: repoFiles(),
        },
      ],
    });
    const github = createGitHubClient({
      getToken: fake.getToken,
      fetch: fake.fetch,
      sleep: async () => undefined,
      maxWaitMs: 1_000,
    });
    // The default config: no `repos`, no `exclude`, every accessible repository.
    ctx = createSyncContext({
      db: h.db,
      pool: h.pool,
      github,
      config: configSchema.parse({}),
    });
    first = await syncAll(ctx, { trigger: "manual" });
    firstBlobRequests = fake.requestsTo(/\/git\/blobs\//).length;
    const repo = await getRepo(h.db, OWNER, REPO);
    ref.id = repo?.id ?? 0;
    rows = await getDocsTree(h.db, { id: ref.id });
    tree = buildDocsTree(rows, "docs");
    docPaths = await getDocPaths(h.db, { id: ref.id });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    await testDb?.drop();
  });

  it("syncs the repository as OKF v0.2 without warnings", async () => {
    expect(first.run.ran).toBe(true);
    if (!first.run.ran) return;
    expect(first.run.status).toBe("success");
    expect(first.fatal).toBeNull();
    const [entry] = first.run.value;
    expect(entry).toMatchObject({
      repo: `${OWNER}/${REPO}`,
      status: "ok",
      added: MARKDOWN.length,
      updated: 0,
      skipped: 0,
      failedFilesTotal: 0,
      warningsTotal: 0,
    });
    // One blob request per Markdown file and one for the README; nothing else is fetched.
    expect(firstBlobRequests).toBe(MARKDOWN.length + 1);

    const repo = await getRepo(h.db, OWNER, REPO);
    expect(repo).toMatchObject({
      visibility: "public",
      syncStatus: "ok",
      syncError: null,
      syncWarnings: [],
      docsPath: "docs",
      isOkf: true,
      okfVersion: "0.2",
      defaultBranch: BRANCH,
    });
    expect(repo?.readme?.path).toBe("README.md");
  });

  it("stores every document once, with the type it was authored with", () => {
    expect(rows.map((r) => r.path)).toEqual([...MARKDOWN_PATHS].sort());
    expect(docPaths).toEqual(MARKDOWN_PATHS);
    const typed = Object.fromEntries(
      rows.filter((r) => r.reserved === null).map((r) => [r.path, r.type]),
    );
    expect(typed).toEqual(EXPECTED_TYPES);
  });

  it("treats index.md and log.md as reserved files, never as typed concepts", () => {
    const reserved = rows.filter((r) => r.reserved !== null);
    expect(reserved.map((r) => r.path)).toEqual(RESERVED_PATHS);
    for (const row of reserved) {
      expect(row.type, row.path).toBeNull();
      expect(row.status, row.path).toBeNull();
      expect(row.reserved, row.path).toBe(row.path.endsWith("log.md") ? "log" : "index");
    }
  });

  it("builds a nested table of contents with folder summaries", () => {
    expect(tree.index?.path).toBe("docs/index.md");
    // Documents of the root first (`log.md` last among them), then the folders by name.
    expect(tree.children.map((c) => (c.kind === "doc" ? c.path : c.name))).toEqual([
      "docs/github-app-setup.md",
      "docs/log.md",
      ...FOLDERS,
    ]);
    const titles = (name: string): string[] => {
      const folder = tree.children.find((c) => c.kind === "folder" && c.name === name);
      if (folder?.kind !== "folder") throw new Error(`no folder ${name}`);
      return folder.children
        .map((c) => c.kind === "doc" && c.title)
        .filter((t): t is string => !!t);
    };
    expect(titles("architecture")).toEqual([
      "Data model",
      "Security model",
      "Sync engine",
      "System overview",
    ]);
    expect(titles("guides")).toEqual([
      "Ask the docs",
      "Comments",
      "Configuration",
      "Getting started",
      "OKF support",
      "Search",
      "Webhooks",
    ]);
    expect(titles("reference")).toEqual(["Frontmatter", "HTTP API", "Operations"]);
    expect(titles("decisions")).toHaveLength(4);

    for (const name of FOLDERS) {
      const folder = tree.children.find((c) => c.kind === "folder" && c.name === name);
      if (folder?.kind !== "folder") throw new Error(`no folder ${name}`);
      expect(folder.index?.path, name).toBe(`docs/${name}/index.md`);
      const index = MARKDOWN.find((f) => f.path === `docs/${name}/index.md`) as DiskFile;
      expect(folder.index?.description, name).toBe(frontmatterOf(index).description);
      expect(folder.index?.description?.length, name).toBeGreaterThan(30);
    }
    // Previous and next follow the same order as the tree.
    const flat = flattenDocsTree(tree);
    expect(flat).toHaveLength(MARKDOWN.length);
    expect(flat[0]?.path).toBe("docs/index.md");
    const around = adjacentInTree(tree, "docs/guides/getting-started.md");
    expect(around?.previous?.path).toBe("docs/guides/configuration.md");
    expect(around?.next?.path).toBe("docs/guides/okf-support.md");
  });

  it("shows the type filter values with counts, and combines with tags and status", async () => {
    const facets = await getRepoFacets(h.db, { id: ref.id });
    expect(facets.total).toBe(Object.keys(EXPECTED_TYPES).length);
    // By count, then by value.
    expect(facets.types).toEqual([
      { value: "Guide", count: 8 },
      { value: "Concept", count: 4 },
      { value: "Decision", count: 4 },
      { value: "Reference", count: 2 },
      { value: "Runbook", count: 1 },
    ]);
    expect(facets.statuses).toEqual([
      { value: "stable", count: 14 },
      { value: "accepted", count: 4 },
      { value: "draft", count: 1 },
    ]);

    // Tag counts follow the frontmatter on disk.
    const expectedTags = new Map<string, number>();
    for (const file of MARKDOWN) {
      const tags = frontmatterOf(file).tags;
      if (!Array.isArray(tags) || RESERVED_PATHS.includes(file.path)) continue;
      for (const tag of new Set(tags as string[])) {
        expectedTags.set(tag, (expectedTags.get(tag) ?? 0) + 1);
      }
    }
    expect(new Map(facets.tags.map((t) => [t.value, t.count]))).toEqual(expectedTags);

    // Selecting a type narrows the others' counts the way the UI relies on.
    const guides = await getRepoFacets(h.db, { id: ref.id }, { type: "Guide" });
    expect(guides.total).toBe(8);
    expect(guides.types.map((t) => t.value)).toContain("Decision");
    expect(guides.statuses).toEqual([
      { value: "stable", count: 7 },
      { value: "draft", count: 1 },
    ]);
    const both = await getRepoFacets(h.db, { id: ref.id }, { type: "Guide", status: "draft" });
    expect(both.total).toBe(1);
  });

  it("renders every stored document with no warnings, no broken links and matching headings", async () => {
    let diagrams = 0;
    let tables = 0;
    let footnotes = 0;
    let tasks = 0;
    let highlighted = 0;
    for (const path of MARKDOWN_PATHS) {
      const doc = await getDocumentByPath(h.db, { id: ref.id }, [path]);
      expect(doc, path).not.toBeNull();
      if (doc === null) continue;
      const result = await renderMarkdown(doc.body, {
        links: contextFor(path, docPaths),
        slots: { highlight: [rehypeHighlight] },
      });
      expect(result.warnings, path).toEqual([]);
      expect(result.html, path).not.toContain("dmr-broken-link");
      expect(result.html, path).not.toMatch(/<script|onerror=|javascript:/i);
      // The renderer and the sync agree on every heading and slug (search deep links use them).
      expect(result.headings, path).toEqual(doc.headings);

      const fences = collect(doc.body).fences;
      const mermaid = fences.filter((f) => f.lang === "mermaid").length;
      expect(result.html.match(/<pre class="dmr-mermaid">/g)?.length ?? 0, path).toBe(mermaid);
      diagrams += mermaid;
      const code = fences.filter(
        (f) => f.lang !== null && f.lang !== "mermaid" && f.lang !== "text",
      );
      expect(
        result.html.match(/<pre class="shiki/g)?.length ?? 0,
        `${path} highlighted blocks`,
      ).toBe(code.length);
      highlighted += code.length;
      tables += result.html.includes("<table") ? 1 : 0;
      footnotes += result.html.includes("data-footnotes") ? 1 : 0;
      tasks += result.html.includes("task-list-item") ? 1 : 0;
    }
    expect(diagrams).toBeGreaterThanOrEqual(4);
    expect(highlighted).toBeGreaterThan(10);
    expect(tables).toBeGreaterThan(5);
    expect(footnotes).toBeGreaterThanOrEqual(1);
    expect(tasks).toBeGreaterThanOrEqual(1);
  });

  it("serves the architecture image through the proxy URL", async () => {
    const doc = await getDocumentByPath(h.db, { id: ref.id }, ["docs/architecture/overview.md"]);
    const result = await renderMarkdown(doc?.body ?? "", {
      links: contextFor("docs/architecture/overview.md", docPaths),
    });
    expect(result.html).toContain(`src="/api/asset/${OWNER}/${REPO}/docs/images/data-flow.svg"`);
    expect(result.html).toContain('loading="lazy"');
  });

  it("finds the right documents first", async () => {
    const top = async (q: string, expectedPath: string) => {
      const result = await searchDocuments(h.db, { q });
      expect(result.hits[0]?.doc.path, `first hit of "${q}"`).toBe(expectedPath);
      return result;
    };
    await top("sync engine", "docs/architecture/sync-engine.md");
    await top("data model", "docs/architecture/data-model.md");
    await top("advisory locks", "docs/decisions/0002-advisory-locks-no-queue.md");
    await top("mermaid", "docs/decisions/0004-mermaid-client-side.md");
    await top("frontmatter", "docs/reference/frontmatter.md");
    await top("getting started", "docs/guides/getting-started.md");

    // A phrase that is a heading links straight to it.
    const phrase = await top('"removal rule"', "docs/architecture/sync-engine.md");
    expect(phrase.hits[0]?.heading?.slug).toBe("removal-rule");
    expect(phrase.hits[0]?.snippet.length).toBeGreaterThan(0);

    // `or` widens, `-` narrows.
    const either = await searchDocuments(h.db, { q: "webhook or scheduler" });
    const webhook = await searchDocuments(h.db, { q: "webhook" });
    const scheduler = await searchDocuments(h.db, { q: "scheduler" });
    expect(either.total).toBeGreaterThanOrEqual(Math.max(webhook.total, scheduler.total));
    const without = await searchDocuments(h.db, { q: "sync -scheduler", limit: 100 });
    const withAll = await searchDocuments(h.db, { q: "sync", limit: 100 });
    expect(without.total).toBeLessThan(withAll.total);
    expect(without.hits.map((x) => x.doc.path)).not.toContain("docs/architecture/sync-engine.md");

    // Hostile input never fails, and a query of only negations matches nothing.
    await expect(searchDocuments(h.db, { q: '"unclosed & | ! (' })).resolves.toBeDefined();
    expect((await searchDocuments(h.db, { q: "-scheduler" })).total).toBe(0);

    // The reserved change log is found by its text and is not a typed concept.
    const log = await searchDocuments(h.db, { q: "change log" });
    const hit = log.hits.find((x) => x.doc.path === "docs/log.md");
    expect(hit?.doc).toMatchObject({ reserved: "log", type: null, status: null, tags: [] });
  });

  it("filters search by type, tag, status and repository, with facet counts", async () => {
    const decisions = await searchDocuments(h.db, { q: "sync", type: "Decision", limit: 100 });
    expect(decisions.total).toBeGreaterThan(0);
    expect(decisions.hits.every((x) => x.doc.type === "Decision")).toBe(true);

    const facets = await searchFacets(h.db, { q: "sync" });
    expect(facets.repos).toEqual([
      expect.objectContaining({ owner: OWNER, name: REPO, count: facets.total }),
    ]);
    expect(facets.types.map((t) => t.value)).toEqual(
      expect.arrayContaining(["Concept", "Guide", "Decision"]),
    );
    expect(facets.types.every((t) => t.value in invert(EXPECTED_TYPES))).toBe(true);

    const drafts = await searchDocuments(h.db, { q: "github app", status: "draft" });
    expect(drafts.hits.map((x) => x.doc.path)).toEqual(["docs/github-app-setup.md"]);
    const none = await searchDocuments(h.db, { q: "sync", repo: "nobody/else" });
    expect(none.total).toBe(0);
    const mine = await searchDocuments(h.db, { q: "sync", repo: `${OWNER}/${REPO}`, tag: "sync" });
    expect(mine.total).toBeGreaterThan(0);
  });

  it("flags a draft guide and, at the right time, stale documents", async () => {
    const early = new Date("2026-10-11T00:00:00Z");
    let withStaleAfter = 0;
    for (const path of Object.keys(EXPECTED_TYPES)) {
      const doc = await getDocumentByPath(h.db, { id: ref.id }, [path]);
      if (doc === null) throw new Error(path);
      const meta = buildOkfMeta(doc.frontmatter, {
        type: doc.type,
        tags: doc.tags,
        status: doc.status,
        description: doc.description,
      });
      expect(meta.type, path).toBe(EXPECTED_TYPES[path]);
      // Every key the bundle uses is one the metadata card knows: nothing falls to "unknown".
      expect(
        meta.unknown.map((u) => u.key),
        path,
      ).toEqual([]);
      const notices = buildNotices(meta, early);
      expect(
        notices.map((n) => n.kind),
        path,
      ).toEqual(path === "docs/github-app-setup.md" ? ["draft"] : []);
      if (meta.staleAfter !== null) withStaleAfter++;
      if (meta.staleAfter !== null) {
        expect(meta.staleAfter.valid, path).toBe(true);
        expect(staleness(meta, early).state, path).toBe("upcoming");
        // Far in the future, every dated document would warn: the feature works end to end.
        expect(
          buildNotices(meta, new Date("3000-06-01T00:00:00Z")).map((n) => n.kind),
          path,
        ).toContain("stale");
      }
    }
    expect(withStaleAfter).toBe(Object.keys(EXPECTED_TYPES).length - 1);

    // The operations runbook carries a real review date: valid through 2027-06-30, stale after.
    const operations = await getDocumentByPath(h.db, { id: ref.id }, [
      "docs/reference/operations.md",
    ]);
    const meta = buildOkfMeta(operations?.frontmatter ?? {}, {
      type: operations?.type ?? null,
      tags: operations?.tags ?? [],
      status: operations?.status ?? null,
      description: operations?.description ?? null,
    });
    expect(buildNotices(meta, new Date("2027-06-30T23:00:00Z"))).toEqual([]);
    expect(buildNotices(meta, new Date("2027-07-01T00:00:01Z")).map((n) => n.kind)).toEqual([
      "stale",
    ]);
    expect(meta.generated?.valid && meta.verified?.valid).toBe(true);
    expect(meta.sources.items.length).toBeGreaterThan(0);
  });

  it("is reported by the status endpoint as one healthy repository", async () => {
    const response = await handleStatusRequest(new Request("http://localhost/api/status"), {
      db: () => h.db,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      summary: Record<string, number>;
      lastRun: { status: string; trigger: string };
      repos: { owner: string; name: string; warnings: unknown[] }[];
    };
    expect(body.summary).toMatchObject({ repos: 1, ok: 1, error: 0, withWarnings: 0 });
    expect(body.lastRun).toMatchObject({ status: "success", trigger: "manual" });
    expect(body.repos).toEqual([
      expect.objectContaining({ owner: OWNER, name: REPO, warnings: [] }),
    ]);
  });

  it("syncs incrementally: nothing changed costs no tree or blob request, one edit costs one blob", async () => {
    fake.clearRequests();
    const again = await syncAll(ctx, { trigger: "manual" });
    expect(again.run.ran && again.run.status).toBe("success");
    expect(again.run.ran && again.run.value[0]?.status).toBe("unchanged");
    expect(fake.requestsTo(/\/git\/(trees|blobs)\//)).toHaveLength(0);

    const log = MARKDOWN.find((f) => f.path === "docs/log.md") as DiskFile;
    fake.setFile(REPO_ID, "docs/log.md", `${textOf(log)}\n- A later entry.\n`);
    fake.clearRequests();
    const edited = await syncAll(ctx, { trigger: "manual" });
    expect(edited.run.ran && edited.run.value[0]).toMatchObject({
      status: "ok",
      updated: 1,
      added: 0,
    });
    expect(fake.requestsTo(/\/git\/blobs\//)).toHaveLength(1);
    const count = await h.db.execute(sql`select count(*)::int as n from documents`);
    expect(count.rows[0]?.n).toBe(MARKDOWN.length);
  });
});

function invert(map: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([path, type]) => [type, path]));
}
