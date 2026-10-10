import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  MAX_SEARCH_OFFSET,
  splitHighlights,
} from "../../lib/search";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import { documents, repos, type Heading } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import {
  MAX_HEADINGS_CONSIDERED,
  MAX_HEADLINE_SOURCE_CHARS,
  RANK_WEIGHTS,
  searchDocuments,
  searchFacets,
  type SearchHit,
  type SearchParams,
} from "./search";
import { publicReposOnly, type RepoVisibilityFilter } from "./visibility";

describe("RANK_WEIGHTS", () => {
  it("separates the four fields by more than repetition within one field can add", () => {
    // ts_rank sums repeated positions of one term as w * sum(1/n^2) < w * 1.645.
    const [d, c, b, a] = RANK_WEIGHTS;
    expect(d * 1.645).toBeLessThan(c);
    expect(c * 1.645).toBeLessThan(b);
    expect(b * 1.645).toBeLessThan(a);
  });
});

type Seed = { api: number; handbook: number; secret: number; big: number; long: number };

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
  title: string,
  extra: Partial<typeof documents.$inferInsert> = {},
): typeof documents.$inferInsert {
  return {
    repoId,
    path,
    title,
    blobSha: `sha-${path}`,
    sizeBytes: 10,
    body: "Plain filler text.",
    ...extra,
  };
}

/** Markdown and HTML around the words a snippet must keep and the ones it must drop. */
const MARKUP_BODY = [
  "---",
  "title: Markup heavy",
  "---",
  '# Heading with [quarkword guide](https://example.com/docs/quarkword-url "tooltip")',
  "",
  "| Column | Notes |",
  "|--------|-------|",
  '| **quarkword** | <span class="note" data-x="ledgerword">see `ledgerword` &amp; more</span> |',
  "",
  "> **Note**",
  "> The ~~old~~ quarkword is covered in the [reference][ref]. ![diagram](img/quarkword.png)",
  "",
  "```ts",
  'const x = "ledgerword"; // quarkword in code',
  "```",
  "",
  '[ref]: https://example.com/ref "Ref title"',
  "Footnote[^1] with &#x27;quotes&#x27; and &lt;T&gt; generics.",
].join("\n");

const BIG_DOCS = 2000;
const LONG_DOCS = 20;
const LONG_BODY_CHARS = 200_000;
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];

/** A ~200 KB body of distinct-ish words with `term` near the start, middle and end. */
function longBody(i: number, term: string): string {
  const parts: string[] = [`Intro ${term} first.`];
  let size = 0;
  for (let n = 0; size < LONG_BODY_CHARS; n++) {
    const word = `${WORDS[n % WORDS.length]}${(n * 7 + i) % 5000}`;
    parts.push(word);
    size += word.length + 1;
    if (n === 12_000) parts.push(`middle ${term} here`);
  }
  parts.push(`last ${term} words`);
  return parts.join(" ");
}

async function seed(db: Db): Promise<Seed> {
  const api = await insertRepo(db, {
    githubId: 1,
    owner: "acme",
    name: "api-service",
    visibility: "public",
  });
  const handbook = await insertRepo(db, {
    githubId: 2,
    owner: "Acme",
    name: "Handbook",
    visibility: "public",
    isOkf: true,
  });
  const secret = await insertRepo(db, {
    githubId: 3,
    owner: "acme",
    name: "secret",
    visibility: "private",
    docsPath: "documentation",
  });
  const big = await insertRepo(db, {
    githubId: 4,
    owner: "zeta",
    name: "big",
    visibility: "public",
  });
  const long = await insertRepo(db, {
    githubId: 5,
    owner: "zeta",
    name: "long",
    visibility: "public",
  });

  await db.insert(documents).values([
    // Ranking: one word in each field.
    doc(api, "docs/rank/title.md", "Zebrafish guide"),
    doc(api, "docs/rank/heading.md", "Other one", {
      headings: [
        { depth: 1, text: "Other one", slug: "other-one" },
        { depth: 2, text: "Zebrafish setup", slug: "zebrafish-setup" },
      ],
    }),
    doc(api, "docs/rank/description.md", "Other two", { description: "All about zebrafish" }),
    doc(api, "docs/rank/tag.md", "Other three", { tags: ["zebrafish"] }),
    doc(api, "docs/rank/body.md", "Other four", { body: "We once saw a zebrafish here." }),
    doc(api, "docs/rank/body-many.md", "Other five", {
      body: Array.from({ length: 40 }, () => "zebrafish").join(" "),
    }),
    // Spec scenarios.
    doc(api, "docs/deploy/deployment.md", "Deployment", { body: "How we ship code." }),
    doc(api, "docs/deploy/notes.md", "Release notes", {
      body: "Notes. The Deployment happens on Fridays, then we rest for the whole weekend.",
    }),
    doc(api, "docs/limits.md", "Quotas", {
      description: "Request quotas",
      body: "Every client has a rate limit. Exceeding the rate limit returns 429.",
      headings: [
        { depth: 1, text: "Quotas", slug: "quotas" },
        { depth: 2, text: "Overview", slug: "overview" },
        { depth: 2, text: "Rate", slug: "rate" },
        { depth: 2, text: "Rate limit headers", slug: "rate-limit-headers" },
        { depth: 3, text: "Rate limit headers", slug: "rate-limit-headers-1" },
      ],
    }),
    doc(api, "docs/limits-reversed.md", "Throttling", {
      body: "The limit applies to the request rate of each client.",
    }),
    doc(api, "docs/kubernetes.md", "Deploy to Kubernetes", { body: "Deploy with kubectl." }),
    doc(api, "docs/vm.md", "Deploy to VMs", { body: "Deploy with ssh." }),
    // Snippets.
    doc(api, "docs/xss.md", "Unsafe content", {
      body: `Intro <script>alert("snippetword")</script> and <mark>fake</mark> ${HIGHLIGHT_START}fake${HIGHLIGHT_END} then the snippetword appears <img src=x onerror=alert(1)> **bold** [link](http://x).`,
    }),
    doc(api, "docs/markup.md", "Markup heavy", { body: MARKUP_BODY }),
    doc(api, "docs/script-only.md", "Script only", {
      body: 'Visible words. <script>alert("scriptleak")</script> <!-- commentleak --> More visible words.',
    }),
    doc(api, "docs/title-only.md", "Titleonlyword page", {
      description: "A described page",
      body: "Body without the word.",
    }),
    doc(api, "docs/title-only-nodesc.md", "Titleonlyword plain", {
      body: "First words of the body come back when nothing in the body matches.",
    }),
    doc(api, "docs/odd-headings.md", "Odd headings", {
      body: "oddheading text",
      headings:
        sql`'[{"depth":"x","text":"oddheading","slug":"bad"},null,{"depth":2,"text":"oddheading","slug":""},{"depth":2,"text":"oddheading ok","slug":"ok"}]'::jsonb` as unknown as Heading[],
    }),
    doc(api, "docs/scalar-headings.md", "Scalar headings", {
      body: "oddheading text",
      headings: sql`'"oddheading"'::jsonb` as unknown as Heading[],
    }),
    // Unicode.
    doc(api, "docs/unicode.md", "Café crème", {
      body: "Naïve résumé. 日本語 ドキュメント. مرحبا بالعالم. Straße. 🦄 unicorn",
    }),
    doc(api, "docs/stemming.md", "Running services", { body: "The runner runs jobs." }),
    // OKF facets.
    doc(handbook, "docs/index.md", "Handbook", {
      body: "facetword index",
      reserved: "index",
      frontmatter: { okf_version: "0.2" },
    }),
    doc(handbook, "docs/log.md", "Changelog", { body: "facetword log", reserved: "log" }),
    doc(handbook, "docs/guide-a.md", "Guide A", {
      body: "facetword",
      type: "Guide",
      tags: ["onboarding", "setup"],
      status: "draft",
    }),
    doc(handbook, "docs/guide-b.md", "Guide B", {
      body: "facetword",
      type: "Guide",
      tags: ["setup"],
      status: "verified",
    }),
    doc(handbook, "docs/guide-lower.md", "guide lower", {
      body: "facetword",
      type: "guide",
      tags: ["Setup"],
    }),
    doc(handbook, "docs/runbook.md", "Runbook", {
      body: "facetword",
      type: "Runbook",
      tags: ["ops"],
      status: "draft",
    }),
    doc(handbook, "docs/untyped.md", "Untyped", { body: "facetword", tags: ["ops", "setup"] }),
    doc(api, "docs/api-guide.md", "API guide", {
      body: "facetword",
      type: "Guide",
      tags: ["setup"],
      status: "draft",
    }),
    // Private repository.
    doc(secret, "documentation/plan.md", "Private plan", {
      body: "facetword secretword",
      type: "Guide",
      tags: ["secret-tag"],
      status: "draft",
    }),
    doc(secret, "documentation/more.md", "More private", {
      body: "secretword",
      type: "Hidden type",
    }),
  ]);

  const bigDocs = Array.from({ length: BIG_DOCS }, (_, i) =>
    doc(big, `docs/section-${i % 40}/page-${i}.md`, `Page ${i} ${WORDS[i % WORDS.length]}`, {
      body: `${WORDS[(i * 3) % WORDS.length]} ${WORDS[(i * 5) % WORDS.length]} corpusword ${i % 2 === 0 ? "evenword" : "oddword"} ${"lorem ipsum dolor sit amet ".repeat(40)}`,
      headings: [{ depth: 2, text: `Section ${WORDS[i % WORDS.length]}`, slug: "section" }],
      tags: [`tag-${i % 60}`],
      type: i % 3 === 0 ? "Metric" : null,
    }),
  );
  for (let i = 0; i < bigDocs.length; i += 500) {
    await db.insert(documents).values(bigDocs.slice(i, i + 500));
  }
  await db
    .insert(documents)
    .values(
      Array.from({ length: LONG_DOCS }, (_, i) =>
        doc(long, `docs/long-${i}.md`, `Long ${i}`, { body: longBody(i, "longterm") }),
      ),
    );
  return { api, handbook, secret, big, long };
}

const paths = (hits: readonly SearchHit[]) => hits.map((h) => h.doc.path);

describeDb("search on a real database", () => {
  let t: TestDatabase;
  let s: Seed;
  const search = (params: SearchParams, visibility?: RepoVisibilityFilter) =>
    searchDocuments(t.db, params, visibility ? { visibility } : {});
  const facets = (params: SearchParams, visibility?: RepoVisibilityFilter) =>
    searchFacets(t.db, params, visibility ? { visibility } : {});

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await seed(t.db);
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  describe("ranking", () => {
    it("ranks title above heading above description/tag above body", async () => {
      const r = await search({ q: "zebrafish" });
      expect(r.total).toBe(6);
      expect(paths(r.hits)).toEqual([
        "docs/rank/title.md",
        "docs/rank/heading.md",
        // Equal rank (both weight C): ordered by path.
        "docs/rank/description.md",
        "docs/rank/tag.md",
        // Forty body mentions still rank below one description match.
        "docs/rank/body-many.md",
        "docs/rank/body.md",
      ]);
      const ranks = r.hits.map((h) => h.rank);
      expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
      expect(ranks[2]).toBe(ranks[3]);
      expect(ranks[0]).toBeGreaterThan(ranks[1]!);
      expect(ranks[1]).toBeGreaterThan(ranks[2]!);
      expect(ranks[3]).toBeGreaterThan(ranks[4]!);
    });

    it("spec: a title match outranks a single body mention", async () => {
      const r = await search({ q: "Deployment" });
      expect(paths(r.hits)).toEqual(["docs/deploy/deployment.md", "docs/deploy/notes.md"]);
    });

    it("spec: matches body words and orders by relevance", async () => {
      const r = await search({ q: "rate limit" });
      expect(paths(r.hits)).toEqual(["docs/limits.md", "docs/limits-reversed.md"]);
      expect(r.hits[0]!.rank).toBeGreaterThan(r.hits[1]!.rank);
    });

    it("follows websearch syntax: quoted phrase, -exclusion, or", async () => {
      expect(paths((await search({ q: '"rate limit"' })).hits)).toEqual(["docs/limits.md"]);
      expect(paths((await search({ q: "deploy -kubernetes" })).hits)).toEqual(["docs/vm.md"]);
      expect(paths((await search({ q: "kubectl or ssh" })).hits).sort()).toEqual([
        "docs/kubernetes.md",
        "docs/vm.md",
      ]);
      expect((await search({ q: "kubectl ssh" })).total).toBe(0);
    });

    it("is case-insensitive and does not stem (simple config)", async () => {
      expect((await search({ q: "ZEBRAFISH" })).total).toBe(6);
      // Design decision 2: `simple` lowercases only; `run` does not match `running` or `runs`.
      expect(paths((await search({ q: "running" })).hits)).toEqual(["docs/stemming.md"]);
      expect((await search({ q: "run" })).total).toBe(0);
      expect((await search({ q: "deployments" })).total).toBe(0);
    });

    it("matches unicode words; accents are significant", async () => {
      for (const q of ["café", "CAFÉ", "naïve", "résumé", "日本語", "مرحبا", "straße"]) {
        expect(paths((await search({ q })).hits), q).toEqual(["docs/unicode.md"]);
      }
      // No unaccent: `cafe` is a different word.
      expect((await search({ q: "cafe" })).total).toBe(0);
      // Emoji are not words to the parser: an emoji-only query has no term.
      expect((await search({ q: "🦄" })).total).toBe(0);
      expect(paths((await search({ q: "🦄 unicorn" })).hits)).toEqual(["docs/unicode.md"]);
    });

    it("searches reserved index and log pages too", async () => {
      const r = await search({ q: "facetword", repo: "acme/handbook" });
      expect(paths(r.hits)).toEqual(expect.arrayContaining(["docs/index.md", "docs/log.md"]));
      expect(r.hits.find((h) => h.doc.path === "docs/log.md")?.doc.reserved).toBe("log");
    });
  });

  describe("result shape", () => {
    it("returns repository, document, rank, snippet and heading", async () => {
      const r = await search({ q: "rate limit" });
      expect(r).toMatchObject({ query: "rate limit", total: 2, limit: 20, offset: 0 });
      const hit = r.hits[0]!;
      expect(hit.repo).toEqual({
        id: s.api,
        owner: "acme",
        name: "api-service",
        visibility: "public",
        docsPath: "docs",
      });
      expect(hit.doc).toEqual({
        path: "docs/limits.md",
        title: "Quotas",
        description: "Request quotas",
        type: null,
        tags: [],
        status: null,
        reserved: null,
      });
      expect(typeof hit.rank).toBe("number");
      // The first heading with every term wins over partial matches and later duplicates.
      expect(hit.heading).toEqual({
        depth: 2,
        text: "Rate limit headers",
        slug: "rate-limit-headers",
      });
      expect(JSON.stringify(r)).not.toMatch(/searchVector|search_vector/);
    });

    it("returns OKF fields as authored", async () => {
      const r = await search({ q: "facetword", type: "Guide", repo: "Acme/Handbook" });
      const hit = r.hits.find((h) => h.doc.path === "docs/guide-a.md");
      expect(hit?.doc).toMatchObject({
        type: "Guide",
        tags: ["onboarding", "setup"],
        status: "draft",
      });
    });

    it("picks a partially matching heading when none has every term, else null", async () => {
      const partial = await search({ q: "zebrafish setup" });
      expect(partial.hits[0]?.heading?.slug).toBe("zebrafish-setup");
      const none = await search({ q: "kubectl" });
      expect(none.hits[0]?.heading).toBeNull();
    });

    it("ignores malformed stored headings", async () => {
      const r = await search({ q: "oddheading" });
      const odd = r.hits.find((h) => h.doc.path === "docs/odd-headings.md");
      expect(odd?.heading).toEqual({ depth: 2, text: "oddheading ok", slug: "ok" });
      const scalar = r.hits.find((h) => h.doc.path === "docs/scalar-headings.md");
      expect(scalar).toBeDefined();
      expect(scalar?.heading).toBeNull();
    });
  });

  describe("best heading on heading-heavy documents", () => {
    const HEADINGS = 5000;
    const manyHeadings = (matches: Record<number, string>): Heading[] =>
      Array.from({ length: HEADINGS }, (_, i) => ({
        depth: 2,
        text: matches[i] ?? `Topic ${i} filler`,
        slug: `topic-${i}`,
      }));

    async function insertDocs(rows: (typeof documents.$inferInsert)[]): Promise<void> {
      await t.db.insert(documents).values(rows);
    }
    const cleanup = () => t.db.delete(documents).where(sql`${documents.path} like 'docs/heavy/%'`);

    it("caps the headings considered, in document order", async () => {
      expect(MAX_HEADINGS_CONSIDERED).toBe(200);
      try {
        await insertDocs([
          doc(s.long, "docs/heavy/early.md", "Early", {
            body: "headingstorm body",
            headings: manyHeadings({ 7: "Needle headingstorm", 4500: "Late headingstorm" }),
          }),
          doc(s.long, "docs/heavy/edge.md", "Edge", {
            body: "headingstorm body",
            headings: manyHeadings({ [MAX_HEADINGS_CONSIDERED - 1]: "Last headingstorm" }),
          }),
          doc(s.long, "docs/heavy/past-cap.md", "Past cap", {
            body: "headingstorm body",
            headings: manyHeadings({ [MAX_HEADINGS_CONSIDERED]: "First ignored headingstorm" }),
          }),
          doc(s.long, "docs/heavy/late-only.md", "Late only", {
            body: "headingstorm body",
            headings: manyHeadings({ 4999: "Final headingstorm" }),
          }),
        ]);
        const r = await search({ q: "headingstorm", repo: "zeta/long" });
        const slugOf = (path: string) => r.hits.find((h) => h.doc.path === path)?.heading?.slug;
        expect(r.total).toBe(4);
        expect(slugOf("docs/heavy/early.md")).toBe("topic-7");
        expect(slugOf("docs/heavy/edge.md")).toBe(`topic-${MAX_HEADINGS_CONSIDERED - 1}`);
        // A hit still shows up; only the deep-link to a heading past the cap is dropped.
        expect(r.hits.find((h) => h.doc.path === "docs/heavy/past-cap.md")?.heading).toBeNull();
        expect(r.hits.find((h) => h.doc.path === "docs/heavy/late-only.md")?.heading).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("still prefers the heading with more query terms within the cap", async () => {
      try {
        await insertDocs([
          doc(s.long, "docs/heavy/terms.md", "Terms", {
            body: "alphaterm betaterm",
            headings: manyHeadings({ 3: "alphaterm only", 90: "alphaterm betaterm both" }),
          }),
        ]);
        const r = await search({ q: "alphaterm betaterm", repo: "zeta/long" });
        expect(r.hits[0]?.heading?.slug).toBe("topic-90");
      } finally {
        await cleanup();
      }
    });

    it("answers a page of 5000-heading documents in a sane time", async () => {
      const rows = Array.from({ length: 20 }, (_, i) =>
        doc(s.long, `docs/heavy/many-${i}.md`, `Many ${i}`, {
          body: "headingstorm body",
          headings: manyHeadings({ [i]: "Needle headingstorm" }),
        }),
      );
      try {
        await insertDocs(rows);
        const started = performance.now();
        const r = await search({ q: "headingstorm", repo: "zeta/long", limit: 20 });
        const elapsed = performance.now() - started;
        expect(r.total).toBe(20);
        expect(r.hits.every((h) => h.heading?.text === "Needle headingstorm")).toBe(true);
        // Generous: about 4000 tsvectors are built (20 x 200), not 300 000. Catches a regression
        // to unbounded work per heading, not a slow machine.
        expect(elapsed).toBeLessThan(5000);
      } finally {
        await cleanup();
      }
    }, 60_000);
  });

  describe("snippets", () => {
    it("marks matched terms with the sentinels and carries no HTML of ours", async () => {
      const r = await search({ q: "rate limit" });
      const snippet = r.hits[0]!.snippet;
      const marked = splitHighlights(snippet).filter((p) => p.highlighted);
      expect(marked.map((p) => p.text.toLowerCase())).toEqual(
        expect.arrayContaining(["rate", "limit"]),
      );
      expect(snippet).not.toMatch(/<\/?(b|mark|em)>/i);
    });

    it("keeps document markup out of the highlights and drops stray sentinels from the source", async () => {
      const r = await search({ q: "snippetword" });
      const hit = r.hits.find((h) => h.doc.path === "docs/xss.md");
      expect(hit).toBeDefined();
      const parts = splitHighlights(hit!.snippet);
      const marked = parts.filter((p) => p.highlighted).map((p) => p.text);
      expect(marked.length).toBeGreaterThan(0);
      for (const text of marked) expect(text).toBe("snippetword");
      // The sentinel pair the document itself contained is gone: "fake" is never highlighted.
      expect(marked).not.toContain("fake");
      // Markers come in balanced pairs.
      const starts = [...hit!.snippet].filter((c) => c === HIGHLIGHT_START).length;
      const ends = [...hit!.snippet].filter((c) => c === HIGHLIGHT_END).length;
      expect(starts).toBe(ends);
      // The tags and the script content are gone: cleanSnippet removed them (task 10.2).
      expect(hit!.snippet).not.toContain("<script");
      expect(hit!.snippet).not.toContain("<mark");
    });

    it("strips Markdown and HTML from the snippet and keeps the highlights on the right word", async () => {
      const r = await search({ q: "quarkword" });
      const hit = r.hits.find((h) => h.doc.path === "docs/markup.md");
      expect(hit).toBeDefined();
      const snippet = hit!.snippet;
      // No Markdown or HTML syntax is left; entities are decoded.
      for (const syntax of [
        "**",
        "~~",
        "`",
        "](",
        "[^",
        "|",
        "<span",
        "</",
        "<!--",
        "&amp;",
        "&#x27;",
      ]) {
        expect(snippet, syntax).not.toContain(syntax);
      }
      expect(snippet).not.toMatch(/https?:\/\/|example\.com|tooltip|Ref title|data-x|class=/);
      // The words around the matches survive; matches inside links, tables, quotes, code are marked.
      expect(snippet).toContain("Heading with ");
      expect(snippet).toContain("Notes ");
      expect(snippet).toContain("The old ");
      expect(snippet).toContain("see ledgerword & more");
      // Markers: balanced, only around the matched word (never around markup or other words).
      const starts = [...snippet].filter((c) => c === HIGHLIGHT_START).length;
      const ends = [...snippet].filter((c) => c === HIGHLIGHT_END).length;
      expect(starts).toBe(ends);
      const marked = splitHighlights(snippet).filter((p) => p.highlighted);
      expect(marked.length).toBeGreaterThanOrEqual(3);
      for (const part of marked) expect(part.text).toBe("quarkword");
      expect(snippet).toContain(`Heading with ${HIGHLIGHT_START}quarkword${HIGHLIGHT_END} guide`);
      expect(snippet).toContain(`The old ${HIGHLIGHT_START}quarkword${HIGHLIGHT_END} is covered`);
      // Text that only the fence or the table contained is plain text, not highlighted.
      expect(snippet).not.toContain(`${HIGHLIGHT_START}ledgerword`);
    });

    it("never shows script or comment content, which ts_headline alone would show", async () => {
      // The Postgres parser keeps `<script>...</script>` out of the search vector, but a headline
      // over the raw text would print its content; the query layer hides the tags from it.
      const r = await search({ q: "visible" });
      const hit = r.hits.find((h) => h.doc.path === "docs/script-only.md");
      expect(hit).toBeDefined();
      expect(hit!.snippet).toBe(
        `${HIGHLIGHT_START}Visible${HIGHLIGHT_END} words. More ${HIGHLIGHT_START}visible${HIGHLIGHT_END} words`,
      );
    });

    it("falls back to the description, then the body start, when the body does not match", async () => {
      const r = await search({ q: "titleonlyword" });
      const described = r.hits.find((h) => h.doc.path === "docs/title-only.md");
      expect(described?.snippet).toBe("A described page");
      const plain = r.hits.find((h) => h.doc.path === "docs/title-only-nodesc.md");
      expect(plain?.snippet.startsWith("First words of the body")).toBe(true);
      expect(plain?.snippet).not.toContain(HIGHLIGHT_START);
    });

    it("highlights a description match when the body has none", async () => {
      const r = await search({ q: "zebrafish" });
      const hit = r.hits.find((h) => h.doc.path === "docs/rank/description.md");
      expect(hit?.snippet).toBe(`All about ${HIGHLIGHT_START}zebrafish${HIGHLIGHT_END}`);
    });
  });

  describe("empty and hostile queries", () => {
    const noTerm = [
      "",
      " ",
      "\t\n",
      '"',
      '""',
      "-",
      "--",
      "OR",
      "or or",
      "()",
      "&|!<>:*",
      "&&",
      "|",
      "!",
      "<->",
      ":*",
      "\\",
      "%",
      "_",
      ";",
      "/* */",
      "'",
      "`",
      "\u0000",
      "\u0000\u0000",
      "\uD800",
      "🦄",
      "🦄🦄🦄",
      "-zebrafish",
      "zebrafish:* -zebrafish",
      "- - -",
      "‮‭",
      "",
      "　",
    ];
    const hostile = [
      ...noTerm,
      '"unclosed & | ! ( ',
      "a & b | !c <-> d :*",
      "' or '1'='1",
      "x'); drop table documents; --",
      "zebrafish' --",
      "%_%",
      "\\'",
      "a\u0000b",
      "مرحبا‮abc",
      "x".repeat(10_000),
      "zebrafish ".repeat(2_000),
      "word ".repeat(300),
      "((((((((((zebrafish",
      "zebrafish))))))",
      '"zebrafish',
      "zebrafish\\",
      "$1 $2 ${x}",
      "<script>alert(1)</script>",
      "￿￾",
    ];

    it("never throws for hostile input, in search or facets", async () => {
      for (const q of hostile) {
        const label = JSON.stringify(q.slice(0, 40));
        const r = await search({ q }).catch((e: unknown) => {
          throw new Error(`search threw for ${label}: ${String(e)}`);
        });
        expect(Array.isArray(r.hits), label).toBe(true);
        expect(r.total, label).toBeGreaterThanOrEqual(0);
        await expect(facets({ q }), label).resolves.toMatchObject({ query: r.query });
      }
    });

    it("returns nothing (not everything) for queries without a positive term", async () => {
      for (const q of noTerm) {
        const label = JSON.stringify(q);
        const r = await search({ q });
        expect(r.total, label).toBe(0);
        expect(r.hits, label).toEqual([]);
        expect((await facets({ q })).total, label).toBe(0);
      }
    });

    it("treats tsquery syntax as plain words, never as raw tsquery", async () => {
      // As raw tsquery this would be `zebrafish & !zebrafish` (nothing).
      expect((await search({ q: "zebrafish & !zebrafish" })).total).toBe(6);
      expect((await search({ q: "!zebrafish" })).total).toBe(6);
      // `:*` is not a prefix search.
      expect((await search({ q: "zebra:*" })).total).toBe(0);
      expect((await search({ q: "(zebrafish | kubectl)" })).total).toBe(0);
      expect((await search({ q: "' or '1'='1" })).total).toBe(0);
    });

    it("echoes a bounded, cleaned query", async () => {
      const r = await search({ q: `  rate\u0000 limit  ${"x".repeat(10_000)}` });
      expect(r.query.startsWith("rate limit x")).toBe(true);
      expect([...r.query].length).toBeLessThanOrEqual(256);
      expect((await search({ q: 42 })).query).toBe("");
      expect((await search({ q: null })).total).toBe(0);
    });

    it("still finds the document when the input is padded with whitespace and NULs", async () => {
      const r = await search({ q: `"rate limit"${" \u0000\n".repeat(5_000)}` });
      expect(r.query).toBe('"rate limit"');
      expect(paths(r.hits)).toEqual(["docs/limits.md"]);
    });
  });

  describe("filters", () => {
    it("spec: limits results to one repository, by owner/name (any case) or id", async () => {
      const all = await search({ q: "facetword" });
      expect(new Set(all.hits.map((h) => h.repo.name))).toEqual(
        new Set(["Handbook", "api-service", "secret"]),
      );
      for (const repo of ["acme/api-service", "ACME/API-SERVICE", s.api, [s.api]]) {
        const r = await search({ q: "facetword", repo });
        expect(paths(r.hits), String(repo)).toEqual(["docs/api-guide.md"]);
      }
    });

    it("combines several repositories with OR", async () => {
      const r = await search({ q: "facetword", repo: ["acme/api-service", "acme/secret"] });
      expect(paths(r.hits).sort()).toEqual(["docs/api-guide.md", "documentation/plan.md"]);
    });

    it("filters type exactly and case-sensitively", async () => {
      const upper = await search({ q: "facetword", type: "Guide" });
      expect(paths(upper.hits).sort()).toEqual([
        "docs/api-guide.md",
        "docs/guide-a.md",
        "docs/guide-b.md",
        "documentation/plan.md",
      ]);
      const lower = await search({ q: "facetword", type: ["guide"] });
      expect(paths(lower.hits)).toEqual(["docs/guide-lower.md"]);
      const both = await search({ q: "facetword", type: ["guide", "Runbook"] });
      expect(paths(both.hits).sort()).toEqual(["docs/guide-lower.md", "docs/runbook.md"]);
    });

    it("matches any selected tag, exactly", async () => {
      const r = await search({ q: "facetword", tag: ["onboarding", "ops"] });
      expect(paths(r.hits).sort()).toEqual([
        "docs/guide-a.md",
        "docs/runbook.md",
        "docs/untyped.md",
      ]);
      const cased = await search({ q: "facetword", tag: "Setup" });
      expect(paths(cased.hits)).toEqual(["docs/guide-lower.md"]);
    });

    it("filters status and combines kinds with AND", async () => {
      const draft = await search({ q: "facetword", status: "draft" });
      expect(draft.total).toBe(4);
      const r = await search({
        q: "facetword",
        repo: "acme/handbook",
        type: "Guide",
        tag: "setup",
        status: ["draft", "verified"],
      });
      expect(paths(r.hits).sort()).toEqual(["docs/guide-a.md", "docs/guide-b.md"]);
      const none = await search({ q: "facetword", type: "Runbook", status: "verified" });
      expect(none).toMatchObject({ total: 0, hits: [] });
    });

    it("returns nothing for unknown or unusable filter values, and ignores empty lists", async () => {
      const all = (await search({ q: "facetword" })).total;
      expect(all).toBeGreaterThan(5);
      for (const params of [
        { repo: "nobody/nothing" },
        { repo: "not-a-repo" },
        { repo: 999_999 },
        { repo: [-1, 1.5, "a/b/c", ""] },
        { type: "Nope" },
        { type: ["", "x".repeat(300), "a\u0000b"] },
        { tag: "nope" },
        { status: "x".repeat(1000) },
        { type: [42] },
      ]) {
        const r = await search({ q: "facetword", ...params });
        expect(r.total, JSON.stringify(params).slice(0, 60)).toBe(0);
        expect((await facets({ q: "facetword", ...params })).total).toBe(0);
      }
      for (const params of [{ repo: [] }, { type: [] }, { tag: undefined }, { status: null }]) {
        expect((await search({ q: "facetword", ...params })).total).toBe(all);
      }
    });

    it("treats hostile filter values as data", async () => {
      for (const v of ["' or '1'='1", "Guide' --", "%", "_", "\\", "Guide,Runbook", "{Guide}"]) {
        const r = await search({ q: "facetword", type: v, tag: v, status: v, repo: `${v}/${v}` });
        expect(r.total, v).toBe(0);
      }
    });
  });

  describe("facets", () => {
    it("counts per repository, type, tag and status for the same match set", async () => {
      const f = await facets({ q: "facetword" });
      const r = await search({ q: "facetword", limit: 100 });
      expect(f.total).toBe(r.total);
      expect(f.repos).toEqual([
        { id: s.handbook, owner: "Acme", name: "Handbook", count: 7 },
        { id: s.api, owner: "acme", name: "api-service", count: 1 },
        { id: s.secret, owner: "acme", name: "secret", count: 1 },
      ]);
      expect(f.types).toEqual([
        { value: "Guide", count: 4 },
        { value: "Runbook", count: 1 },
        { value: "guide", count: 1 },
      ]);
      expect(f.statuses).toEqual([
        { value: "draft", count: 4 },
        { value: "verified", count: 1 },
      ]);
      expect(f.tags).toEqual([
        { value: "setup", count: 4 },
        { value: "ops", count: 2 },
        { value: "Setup", count: 1 },
        { value: "onboarding", count: 1 },
        { value: "secret-tag", count: 1 },
      ]);
      // Repo counts add up to the total; type counts plus untyped documents do too.
      expect(f.repos.reduce((n, x) => n + x.count, 0)).toBe(f.total);
      const untyped = r.hits.filter((h) => h.doc.type === null).length;
      expect(f.types.reduce((n, x) => n + x.count, 0) + untyped).toBe(f.total);
    });

    it("is disjunctive: a kind's own filter does not narrow its counts, the others do", async () => {
      const f = await facets({ q: "facetword", type: "Guide", status: "draft" });
      const r = await search({ q: "facetword", type: "Guide", status: "draft" });
      expect(f.total).toBe(r.total);
      expect(f.total).toBe(3);
      // Types: narrowed by status=draft only.
      expect(f.types).toEqual([
        { value: "Guide", count: 3 },
        { value: "Runbook", count: 1 },
      ]);
      // Statuses: narrowed by type=Guide only.
      expect(f.statuses).toEqual([
        { value: "draft", count: 3 },
        { value: "verified", count: 1 },
      ]);
      // Repos and tags: narrowed by both.
      expect(f.repos.reduce((n, x) => n + x.count, 0)).toBe(3);
      expect(f.tags.find((x) => x.value === "setup")?.count).toBe(2);
      // Repo filter narrows the other kinds but not the repo counts.
      const byRepo = await facets({ q: "facetword", repo: "acme/api-service" });
      expect(byRepo.total).toBe(1);
      expect(byRepo.repos.length).toBe(3);
      expect(byRepo.types).toEqual([{ value: "Guide", count: 1 }]);
    });

    it("caps tag values and orders by count", async () => {
      const f = await facets({ q: "corpusword" });
      expect(f.total).toBe(BIG_DOCS);
      expect(f.tags.length).toBe(50);
      expect(f.types).toEqual([{ value: "Metric", count: Math.ceil(BIG_DOCS / 3) }]);
      const counts = f.tags.map((x) => x.count);
      expect(counts).toEqual([...counts].sort((a, b) => b - a));
    });

    it("is empty for an empty query", async () => {
      expect(await facets({ q: "  " })).toEqual({
        query: "",
        total: 0,
        repos: [],
        types: [],
        tags: [],
        statuses: [],
      });
    });
  });

  describe("visibility", () => {
    it("hides private repositories from hits, totals and every facet count", async () => {
      const shown = await search({ q: "secretword" });
      expect(shown.total).toBe(2);
      const hidden = await search({ q: "secretword" }, publicReposOnly);
      expect(hidden).toMatchObject({ total: 0, hits: [] });

      const f = await facets({ q: "facetword" }, publicReposOnly);
      expect(f.total).toBe(8);
      expect(f.repos.map((x) => x.id)).not.toContain(s.secret);
      expect(f.types.find((x) => x.value === "Guide")?.count).toBe(3);
      expect(f.tags.map((x) => x.value)).not.toContain("secret-tag");
      expect(f.statuses.find((x) => x.value === "draft")?.count).toBe(3);
      const hiddenType = await facets({ q: "secretword" }, publicReposOnly);
      expect(hiddenType.types).toEqual([]);
      // Filtering on the hidden repository finds nothing either.
      expect((await search({ q: "facetword", repo: "acme/secret" }, publicReposOnly)).total).toBe(
        0,
      );
      expect((await facets({ q: "facetword", repo: s.secret }, publicReposOnly)).total).toBe(0);
    });
  });

  describe("paging", () => {
    it("pages stably with no overlap or gap", async () => {
      const all = await search({ q: "corpusword", limit: 100 });
      expect(all.total).toBe(BIG_DOCS);
      expect(all.hits.length).toBe(100);
      const pages: SearchHit[] = [];
      for (let offset = 0; offset < 100; offset += 7) {
        pages.push(...(await search({ q: "corpusword", limit: 7, offset })).hits);
      }
      expect(paths(pages.slice(0, 100))).toEqual(paths(all.hits));
      // Same query twice: same order.
      expect(paths((await search({ q: "corpusword", limit: 100 })).hits)).toEqual(paths(all.hits));
    });

    it("clamps the limit and handles offsets past the end", async () => {
      expect((await search({ q: "corpusword", limit: 1000 })).hits.length).toBe(100);
      expect((await search({ q: "corpusword", limit: 0 })).limit).toBe(20);
      expect((await search({ q: "corpusword", limit: "5" })).limit).toBe(20);
      expect((await search({ q: "corpusword", limit: 3.7 })).hits.length).toBe(3);
      const past = await search({ q: "zebrafish", offset: 50 });
      expect(past).toMatchObject({ hits: [], total: 6, offset: 50 });
      const deep = await search({ q: "corpusword", offset: MAX_SEARCH_OFFSET + 1 });
      expect(deep.hits).toEqual([]);
      expect((await search({ q: "corpusword", offset: -3 })).offset).toBe(0);
    });
  });

  describe("performance", () => {
    async function median(run: () => Promise<unknown>): Promise<number> {
      await run();
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await run();
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      return times[2]!;
    }

    it("searches and counts facets on a 2000-document corpus quickly", async () => {
      const broad = await median(() => search({ q: "corpusword" }));
      const narrow = await median(() => search({ q: "evenword alpha" }));
      const facet = await median(() => facets({ q: "corpusword" }));
      expect(broad).toBeLessThan(300);
      expect(narrow).toBeLessThan(300);
      expect(facet).toBeLessThan(300);
    });

    it("keeps ts_headline bounded on 200 KB documents", async () => {
      const r = await search({ q: "longterm", limit: LONG_DOCS });
      expect(r.hits.length).toBe(LONG_DOCS);
      for (const hit of r.hits) expect(hit.snippet).toContain(`${HIGHLIGHT_START}longterm`);
      const time = await median(() => search({ q: "longterm", limit: LONG_DOCS }));
      expect(time).toBeLessThan(1500);
      expect(MAX_HEADLINE_SOURCE_CHARS).toBeLessThan(LONG_BODY_CHARS);
    });

    it("uses the GIN index for the match (EXPLAIN of the real statements)", async () => {
      const captured: { query: string; params: unknown[] }[] = [];
      const logged = drizzle(t.pool, {
        schema,
        logger: { logQuery: (query, params) => void captured.push({ query, params }) },
      });
      // No type filter: with one, the planner may rightly prefer the (repo_id, type) index.
      await searchDocuments(logged, { q: "zebrafish" });
      await searchFacets(logged, { q: "zebrafish" });
      expect(captured.length).toBe(2);
      const client = await t.pool.connect();
      try {
        await client.query("SET enable_seqscan = off");
        for (const { query, params } of captured) {
          expect(query).toContain("websearch_to_tsquery");
          expect(params).toContain("zebrafish");
          const { rows } = await client.query<{ "QUERY PLAN": unknown }>(
            `EXPLAIN (FORMAT JSON) ${query}`,
            params,
          );
          const plan = JSON.stringify(rows[0]?.["QUERY PLAN"]);
          expect(plan).toContain("documents_search_vector_idx");
          expect(plan).toMatch(/search_vector @@/);
        }
      } finally {
        await client.query("RESET enable_seqscan");
        client.release();
      }
    });
  });
});
