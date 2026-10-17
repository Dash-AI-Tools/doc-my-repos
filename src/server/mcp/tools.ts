import { z } from "zod";

import { githubBlobUrl, githubRepoUrl } from "../../lib/github-links";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "../../lib/snippet";
import { docUrl, repoUrl } from "../../lib/routes";
import {
  getDocumentByPath,
  getRepo,
  getRepoFacets,
  getRepoOutline,
  listRepoOverviews,
  searchDocuments,
  type FacetCount,
} from "../queries";
import { searchResultItem } from "../search-page";
import {
  UNTRUSTED_NOTICE,
  block,
  cleanJson,
  fenced,
  line,
  parseRepository,
  plainQuery,
} from "./safe-text";
import { defineTool, type ToolOutput } from "./tool-types";

/**
 * The read tools (mcp-agent-access spec `mcp-server`): `list_repositories`, `get_repository`,
 * `search_documents` and `get_document`. Each reads Postgres through the shared query layer, so
 * the single visibility filter applies to everything they return, and never calls GitHub. Every
 * result is `structuredContent` (data) plus a short text rendering (for clients that read only
 * text), carries the portal link, and passes repository text through `safe-text.ts`: cleaned,
 * bounded, labelled with the untrusted-content `notice`, and fenced in the text rendering.
 *
 * Failures that are the caller's (an unknown repository, a missing document, a bad argument) are
 * tool errors with a fixed message and `structured.error`; anything else is the adapter's fixed
 * "temporarily unavailable". No error text ever comes from the database or the repository.
 */

export const MAX_LISTED_REPOSITORIES = 200;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 20;
export const DEFAULT_OUTLINE_ROWS = 100;
export const MAX_OUTLINE_ROWS = 300;
export const MAX_BODY_CHARACTERS = 100_000;
const MAX_FACET_ROWS = 100;

const NOT_FOUND_REPOSITORY =
  "Repository not found. Use owner/name as returned by list_repositories.";
const NOT_FOUND_DOCUMENT =
  "Document not found in that repository. Use a path returned by search_documents or get_repository.";
const BAD_REPOSITORY = "The repository must be written owner/name.";

const notFound = (text: string): ToolOutput => ({
  structured: { error: "not_found", notice: UNTRUSTED_NOTICE },
  text,
  isError: true,
});
const invalid = (text: string): ToolOutput => ({
  structured: { error: "invalid_argument" },
  text,
  isError: true,
});

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
};

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

const absolute = (origin: string, path: string): string => `${origin}${path}`;

function facets(items: readonly FacetCount[]): { value: string; count: number }[] {
  return items
    .slice(0, MAX_FACET_ROWS)
    .map((f) => ({ value: line(f.value, 100), count: f.count }))
    .filter((f) => f.value !== "");
}

// ---------------------------------------------------------------------------------------------

export const listRepositories = defineTool({
  name: "list_repositories",
  title: "List repositories",
  description:
    "Lists the repositories whose documentation is synced: owner, name, description, whether the " +
    "repository uses Open Knowledge Format (OKF) and which version, how many documents it has, " +
    "its docs folder and when it was last synced. At most 200, in alphabetical order.",
  inputShape: {},
  run: async (_args, ctx) => {
    const rows = await listRepoOverviews(ctx.db, { limit: MAX_LISTED_REPOSITORIES + 1 });
    const truncated = rows.length > MAX_LISTED_REPOSITORIES;
    const repositories = rows.slice(0, MAX_LISTED_REPOSITORIES).map((r) => ({
      repository: `${r.owner}/${r.name}`,
      owner: r.owner,
      name: r.name,
      description: line(r.description),
      isOkf: r.isOkf,
      okfVersion: r.okfVersion === null ? null : line(r.okfVersion, 40),
      documents: r.docCount,
      docsFolder: r.docsPath === null ? null : line(r.docsPath, 200),
      lastSyncedAt: iso(r.lastSyncedAt),
      url: absolute(ctx.origin, repoUrl(r.owner, r.name)),
    }));
    const lines = repositories.map(
      (r) =>
        `${r.repository}: ${r.documents} documents${r.isOkf ? `, OKF${r.okfVersion ? ` ${r.okfVersion}` : ""}` : ""}` +
        `${r.docsFolder ? `, docs in ${r.docsFolder}` : ""}${r.description ? `. ${r.description}` : ""}`,
    );
    return {
      structured: { notice: UNTRUSTED_NOTICE, repositories, truncated },
      text:
        repositories.length === 0
          ? "No repositories are synced yet."
          : `${UNTRUSTED_NOTICE}\n${fenced(lines.join("\n"))}${truncated ? `\nOnly the first ${MAX_LISTED_REPOSITORIES} are listed.` : ""}`,
    };
  },
});

// ---------------------------------------------------------------------------------------------

export const getRepository = defineTool({
  name: "get_repository",
  title: "Get a repository",
  description:
    "Describes one repository: the same fields as list_repositories, an outline of its documents " +
    "(path, title, type, status; up to the first 100 by path unless outline_limit asks for more, " +
    "at most 300) and the types, tags and statuses its documents already use, with counts. Use " +
    "the vocabulary before inventing a new type or tag.",
  inputShape: {
    repository: z.string().max(200).describe("The repository as owner/name."),
    outline_limit: z
      .number()
      .int()
      .optional()
      .describe("How many documents to outline, 1 to 300 (default 100)."),
  },
  run: async ({ repository, outline_limit }, ctx) => {
    const ref = parseRepository(repository);
    if (ref === null) return invalid(BAD_REPOSITORY);
    const repo = await getRepo(ctx.db, ref.owner, ref.name);
    if (repo === null) return notFound(NOT_FOUND_REPOSITORY);
    const rows = clamp(outline_limit, 1, MAX_OUTLINE_ROWS, DEFAULT_OUTLINE_ROWS);
    const [outline, vocabulary] = await Promise.all([
      getRepoOutline(ctx.db, { id: repo.id }, rows),
      getRepoFacets(ctx.db, { id: repo.id }),
    ]);
    const documents = outline.docs.map((d) => ({
      path: d.path,
      title: line(d.title),
      type: d.type === null ? null : line(d.type, 100),
      status: d.status === null ? null : line(d.status, 100),
      reserved: d.reserved,
    }));
    const name = `${repo.owner}/${repo.name}`;
    const structured = {
      notice: UNTRUSTED_NOTICE,
      repository: name,
      owner: repo.owner,
      name: repo.name,
      description: line(repo.description),
      isOkf: repo.isOkf,
      okfVersion: repo.okfVersion === null ? null : line(repo.okfVersion, 40),
      documents: outline.total,
      docsFolder: repo.docsPath === null ? null : line(repo.docsPath, 200),
      lastSyncedAt: iso(repo.lastSyncedAt),
      url: absolute(ctx.origin, repoUrl(repo.owner, repo.name)),
      githubUrl: githubRepoUrl(repo.htmlUrl, repo.owner, repo.name),
      outline: documents,
      outlineTruncated: outline.total > documents.length,
      vocabulary: {
        types: facets(vocabulary.types),
        tags: facets(vocabulary.tags),
        statuses: facets(vocabulary.statuses),
      },
    };
    const list = (items: { value: string; count: number }[]) =>
      items.length === 0 ? "none" : items.map((i) => `${i.value} (${i.count})`).join(", ");
    const text = [
      UNTRUSTED_NOTICE,
      `${name}: ${structured.documents} documents${structured.isOkf ? ", OKF" : ""}${structured.docsFolder ? `, docs in ${structured.docsFolder}` : ""}.`,
      fenced(
        [
          structured.description,
          `Types: ${list(structured.vocabulary.types)}`,
          `Tags: ${list(structured.vocabulary.tags)}`,
          `Statuses: ${list(structured.vocabulary.statuses)}`,
          "",
          ...documents.map((d) => `${d.path}: ${d.title}${d.type ? ` [${d.type}]` : ""}`),
        ].join("\n"),
      ),
      structured.outlineTruncated ? `Outline cut at ${documents.length} of ${outline.total}.` : "",
    ]
      .filter((part) => part !== "")
      .join("\n");
    return { structured, text };
  },
});

// ---------------------------------------------------------------------------------------------

function snippetText(snippet: string): string {
  return line(snippet.replaceAll(HIGHLIGHT_START, "").replaceAll(HIGHLIGHT_END, ""), 400);
}

export const searchDocumentsTool = defineTool({
  name: "search_documents",
  title: "Search documents",
  description:
    "Finds documents by a text query, with the portal's full-text search. The query is plain " +
    "words (all must match), never search syntax. Optional filters narrow by repository " +
    "(owner/name), OKF type, tag and status; type, tag and status match exactly. Returns up to " +
    "10 hits (at most 20 with limit) in the portal's order, each with repository, path, title, " +
    "type, tags, status, a snippet and the portal link.",
  inputShape: {
    query: z.string().max(256).describe("What to look for, in plain words."),
    repository: z.string().max(200).optional().describe("Only this repository, as owner/name."),
    type: z.string().max(256).optional().describe("Only documents of this OKF type, exactly."),
    tag: z.string().max(256).optional().describe("Only documents with this tag, exactly."),
    status: z.string().max(256).optional().describe("Only documents with this status, exactly."),
    limit: z.number().int().optional().describe("How many hits, 1 to 20 (default 10)."),
  },
  run: async (args, ctx) => {
    const query = plainQuery(args.query);
    if (query === null) return invalid("The query is empty. Give the words to search for.");
    let repo: string | undefined;
    if (args.repository !== undefined && args.repository.trim() !== "") {
      const ref = parseRepository(args.repository);
      if (ref === null) return invalid(BAD_REPOSITORY);
      repo = `${ref.owner}/${ref.name}`;
    }
    const limit = clamp(args.limit, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
    const result = await searchDocuments(ctx.db, {
      q: query,
      limit,
      ...(repo === undefined ? {} : { repo }),
      ...(args.type ? { type: args.type } : {}),
      ...(args.tag ? { tag: args.tag } : {}),
      ...(args.status ? { status: args.status } : {}),
    });
    const hits = result.hits.map((hit, index) => {
      const item = searchResultItem(hit);
      return {
        position: index + 1,
        repository: `${hit.repo.owner}/${hit.repo.name}`,
        path: hit.doc.path,
        title: line(hit.doc.title),
        description: line(hit.doc.description),
        type: hit.doc.type === null ? null : line(hit.doc.type, 100),
        tags: hit.doc.tags.map((t) => line(t, 100)),
        status: hit.doc.status === null ? null : line(hit.doc.status, 100),
        section: item.section === null ? null : line(item.section),
        snippet: snippetText(hit.snippet),
        url: absolute(ctx.origin, item.href),
      };
    });
    const rendered = hits.map(
      (h) => `${h.position}. ${h.repository}/${h.path}: ${h.title}\n   ${h.snippet}\n   ${h.url}`,
    );
    return {
      structured: {
        notice: UNTRUSTED_NOTICE,
        query: result.query,
        total: result.total,
        hits,
        truncated: result.total > hits.length,
      },
      text:
        hits.length === 0
          ? `No documents match "${line(args.query, 80)}".`
          : `${UNTRUSTED_NOTICE}\n${result.total} matching documents, showing ${hits.length}.\n${fenced(rendered.join("\n"))}`,
    };
  },
});

// ---------------------------------------------------------------------------------------------

export const getDocument = defineTool({
  name: "get_document",
  title: "Get a document",
  description:
    "Reads one document: title, OKF type, status, tags, all frontmatter, headings, the Markdown " +
    "body (cut at 100,000 characters, with a flag), and links to the portal page and the GitHub " +
    "source. Use the repository and path from search_documents or get_repository.",
  inputShape: {
    repository: z.string().max(200).describe("The repository as owner/name."),
    path: z.string().max(1000).describe("The document's path in the repository, as listed."),
  },
  run: async ({ repository, path }, ctx) => {
    const ref = parseRepository(repository);
    if (ref === null) return invalid(BAD_REPOSITORY);
    const repo = await getRepo(ctx.db, ref.owner, ref.name);
    if (repo === null) return notFound(NOT_FOUND_REPOSITORY);
    const wanted = path.trim().replace(/^\.?\/+/, "");
    const doc = wanted === "" ? null : await getDocumentByPath(ctx.db, { id: repo.id }, wanted);
    if (doc === null) return notFound(NOT_FOUND_DOCUMENT);

    const body = block(doc.body, MAX_BODY_CHARACTERS);
    const page = docUrl(repo.owner, repo.name, doc.path, repo.docsPath);
    const source = githubBlobUrl(repo.htmlUrl, repo.owner, repo.name, repo.defaultBranch, doc.path);
    const structured = {
      notice: UNTRUSTED_NOTICE,
      repository: `${repo.owner}/${repo.name}`,
      path: doc.path,
      title: line(doc.title),
      description: line(doc.description),
      type: doc.type === null ? null : line(doc.type, 100),
      status: doc.status === null ? null : line(doc.status, 100),
      tags: doc.tags.map((t) => line(t, 100)),
      reserved: doc.reserved,
      frontmatter: cleanJson(doc.frontmatter),
      headings: doc.headings.map((h) => ({
        depth: h.depth,
        text: line(h.text),
        slug: line(h.slug),
      })),
      body: body.text,
      bodyTruncated: body.truncated,
      url: absolute(ctx.origin, page ?? repoUrl(repo.owner, repo.name)),
      githubUrl: source,
      updatedAt: doc.updatedAt.toISOString(),
    };
    const text = [
      UNTRUSTED_NOTICE,
      `${structured.repository}/${structured.path}: ${structured.title}${structured.type ? ` [${structured.type}]` : ""}`,
      structured.url,
      fenced(body.text),
      body.truncated ? `The body was cut at ${MAX_BODY_CHARACTERS} characters.` : "",
    ]
      .filter((part) => part !== "")
      .join("\n");
    return { structured, text };
  },
});
