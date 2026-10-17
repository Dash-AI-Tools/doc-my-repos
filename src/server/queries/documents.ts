import "server-only";

import { and, eq, or, sql, type SQL } from "drizzle-orm";

import {
  adjacentInTree,
  buildDocsTree,
  type DocsTreeDoc,
  type DocsTreeRow,
} from "../../lib/docs-tree";
import { OKF_GUIDELINES_FILE, OKF_GUIDELINES_FOLDER } from "../../lib/okf-authoring/names";
import { DOC_EXTENSION } from "../../lib/routes";
import type { Db } from "../db/client";
import { documents, repos, type Heading } from "../db/schema";
import {
  isLookupText,
  MAX_PATH_CANDIDATES,
  MAX_PATH_CHARS,
  repoCondition,
  type RepoRef,
} from "./repo-ref";
import { visibleRepos, type QueryOptions } from "./visibility";

/**
 * Document reads for the portal (task 9.1): the docs tree, one document, the path set link
 * rewriting needs, previous/next neighbours and counts. Every query reads `documents` joined to
 * `repos` and filtered with `visibleRepos(options)`. None selects `search_vector` (it is large and
 * only search reads it), so columns are always listed.
 */

/** A document page's content and metadata. */
export interface DocumentDetail {
  readonly id: number;
  readonly repoId: number;
  /** Repo-relative source path (`docs/guides/setup.md`); the GitHub source link uses it. */
  readonly path: string;
  readonly blobSha: string;
  readonly sizeBytes: number;
  readonly title: string;
  readonly description: string | null;
  /** OKF type exactly as authored (case and spacing kept), or null. */
  readonly type: string | null;
  readonly tags: readonly string[];
  readonly status: string | null;
  /** Headings with the slugs the sync computed; use them for the "on this page" outline. */
  readonly headings: readonly Heading[];
  /** Every frontmatter key as authored, unknown keys included. */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Markdown body without frontmatter; render at read time. */
  readonly body: string;
  readonly reserved: "index" | "log" | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Previous and next documents in table-of-contents order. */
export interface AdjacentDocs {
  readonly previous: DocsTreeDoc | null;
  readonly next: DocsTreeDoc | null;
}

const treeColumns = {
  path: documents.path,
  title: documents.title,
  description: documents.description,
  type: documents.type,
  tags: documents.tags,
  status: documents.status,
  reserved: documents.reserved,
};

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
}

/** Stored headings as a clean list: malformed entries are dropped, never thrown on. */
function parseHeadings(value: unknown): Heading[] {
  if (!Array.isArray(value)) return [];
  const out: Heading[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { depth, text, slug } = item as { depth?: unknown; text?: unknown; slug?: unknown };
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > 6) continue;
    if (typeof text !== "string" || typeof slug !== "string") continue;
    out.push({ depth, text, slug });
  }
  return out;
}

/** Stored frontmatter as a plain object; anything else (array, scalar, null) is empty. */
function parseFrontmatterJson(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toTreeRow(row: {
  path: string;
  title: string;
  description: string | null;
  type: string | null;
  tags: unknown;
  status: string | null;
  reserved: "index" | "log" | null;
}): DocsTreeRow {
  return {
    path: row.path,
    title: row.title,
    description: row.description,
    type: row.type,
    tags: stringList(row.tags),
    status: row.status,
    reserved: row.reserved,
  };
}

/** Byte order, so path order does not depend on the database's collation. */
const byPath = sql`${documents.path} collate "C"`;

/** `documents` joined to the visible repository `where` names. */
function visibleDocuments(where: SQL, options: QueryOptions): SQL {
  return and(visibleRepos(options), where) as SQL;
}

/**
 * The flat rows of a repository's docs tree, ordered by path (byte order). Build the tree with
 * `buildDocsTree(rows, repo.docsPath)` from `@/lib/docs-tree`. Empty when the repository is
 * unknown or hidden.
 */
export async function getDocsTree(
  db: Db,
  repo: RepoRef,
  options: QueryOptions = {},
): Promise<DocsTreeRow[]> {
  const where = await repoCondition(db, repo, options);
  if (where === null) return [];
  const rows = await db
    .select(treeColumns)
    .from(documents)
    .innerJoin(repos, eq(repos.id, documents.repoId))
    .where(visibleDocuments(where, options))
    .orderBy(byPath);
  return rows.map(toTreeRow);
}

/** Lookup candidates: valid text only, de-duplicated, order kept, capped. */
function cleanCandidates(paths: string | readonly string[]): string[] {
  const list = typeof paths === "string" ? [paths] : Array.isArray(paths) ? paths : [];
  const out: string[] = [];
  for (const p of list) {
    if (out.length >= MAX_PATH_CANDIDATES) break;
    if (isLookupText(p, MAX_PATH_CHARS) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Splits `docs/A.md` into its stem and lower-case extension, or null without one. */
function splitExtension(path: string): { stem: string; ext: string } | null {
  const m = DOC_EXTENSION.exec(path);
  if (m === null) return null;
  return { stem: path.slice(0, m.index), ext: m[0].toLowerCase() };
}

/** True when `stored` is `candidate` with the extension's case ignored (`A.MD` for `A.md`). */
function sameIgnoringExtensionCase(stored: string, candidate: string): boolean {
  const split = splitExtension(candidate);
  if (split === null) return false;
  return (
    stored.length === candidate.length &&
    stored.startsWith(split.stem) &&
    stored.slice(split.stem.length).toLowerCase() === split.ext
  );
}

/**
 * The document stored at the first matching path of `paths`, or null. Pass the list from
 * `docPathCandidates(repo.docsPath, segments)` for a page route, or one exact path. An exact
 * match wins, in candidate order; failing that, a stored path that differs only in the case of
 * its extension (`A.MD` for `A.md`; the sync accepts both) matches, in candidate order, the
 * lowest path by code point first. Stems are compared exactly (URLs keep case).
 */
export async function getDocumentByPath(
  db: Db,
  repo: RepoRef,
  paths: string | readonly string[],
  options: QueryOptions = {},
): Promise<DocumentDetail | null> {
  const candidates = cleanCandidates(paths);
  if (candidates.length === 0) return null;
  const where = await repoCondition(db, repo, options);
  if (where === null) return null;

  const pathMatches = candidates.map((c) => {
    const split = splitExtension(c);
    if (split === null) return eq(documents.path, c);
    return and(
      sql`starts_with(${documents.path}, ${split.stem})`,
      sql`lower(substr(${documents.path}, char_length(${split.stem}) + 1)) = ${split.ext}`,
    ) as SQL;
  });
  const rows = await db
    .select({
      id: documents.id,
      repoId: documents.repoId,
      path: documents.path,
      blobSha: documents.blobSha,
      sizeBytes: documents.sizeBytes,
      title: documents.title,
      description: documents.description,
      type: documents.type,
      tags: documents.tags,
      status: documents.status,
      headings: documents.headings,
      frontmatter: documents.frontmatter,
      body: documents.body,
      reserved: documents.reserved,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .innerJoin(repos, eq(repos.id, documents.repoId))
    .where(and(visibleDocuments(where, options), or(...pathMatches)))
    .orderBy(byPath)
    .limit(MAX_PATH_CANDIDATES * 4);

  let row = candidates.map((c) => rows.find((r) => r.path === c)).find((r) => r !== undefined);
  for (const c of candidates) {
    if (row !== undefined) break;
    row = rows
      .filter((r) => sameIgnoringExtensionCase(r.path, c))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))[0];
  }
  if (row === undefined) return null;
  return {
    id: row.id,
    repoId: row.repoId,
    path: row.path,
    blobSha: row.blobSha,
    sizeBytes: row.sizeBytes,
    title: row.title,
    description: row.description,
    type: row.type,
    tags: stringList(row.tags),
    status: row.status,
    headings: parseHeadings(row.headings),
    frontmatter: parseFrontmatterJson(row.frontmatter),
    body: row.body,
    reserved: row.reserved,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Every stored document path of a repository: the `docPaths` set `renderMarkdown`'s link
 * resolver needs (`LinkContext`). Empty when the repository is unknown or hidden.
 */
export async function getDocPaths(
  db: Db,
  repo: RepoRef,
  options: QueryOptions = {},
): Promise<Set<string>> {
  const where = await repoCondition(db, repo, options);
  if (where === null) return new Set();
  const rows = await db
    .select({ path: documents.path })
    .from(documents)
    .innerJoin(repos, eq(repos.id, documents.repoId))
    .where(visibleDocuments(where, options));
  return new Set(rows.map((r) => r.path));
}

/**
 * The documents before and after `path` in table-of-contents order (`flattenDocsTree`), or null
 * when `path` is not a page of a visible repository.
 */
export async function getAdjacentDocs(
  db: Db,
  repo: RepoRef,
  path: string,
  options: QueryOptions = {},
): Promise<AdjacentDocs | null> {
  if (!isLookupText(path, MAX_PATH_CHARS)) return null;
  const where = await repoCondition(db, repo, options);
  if (where === null) return null;
  const rows = await db
    .select({ ...treeColumns, docsPath: repos.docsPath })
    .from(documents)
    .innerJoin(repos, eq(repos.id, documents.repoId))
    .where(visibleDocuments(where, options))
    .orderBy(byPath);
  const first = rows[0];
  if (first === undefined) return null;
  return adjacentInTree(buildDocsTree(rows.map(toTreeRow), first.docsPath), path);
}

/** Most rows `getRepoOutline` returns, whatever the caller asks for. */
export const MAX_OUTLINE_ROWS = 1000;
const DEFAULT_OUTLINE_ROWS = 100;

/** A repository's documents for an overview: how many exist and the first rows by path. */
export interface RepoOutline {
  /** Every stored document of the repository, reserved files included. */
  readonly total: number;
  /** At most `limit` rows in byte order of path; fewer than `total` when it was cut. */
  readonly docs: DocsTreeRow[];
}

/**
 * The first `limit` documents of a visible repository by path (default 100, at most
 * `MAX_OUTLINE_ROWS`; anything else is the default) and the total count: an outline whose size is
 * bounded in the database, so a repository of thousands of documents costs the same as a small
 * one. Empty (`total` 0) when the repository is unknown or hidden.
 */
export async function getRepoOutline(
  db: Db,
  repo: RepoRef,
  limit: number = DEFAULT_OUTLINE_ROWS,
  options: QueryOptions = {},
): Promise<RepoOutline> {
  const where = await repoCondition(db, repo, options);
  if (where === null) return { total: 0, docs: [] };
  const rowsWanted =
    Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_OUTLINE_ROWS
      ? limit
      : DEFAULT_OUTLINE_ROWS;
  const [rows, total] = await Promise.all([
    db
      .select(treeColumns)
      .from(documents)
      .innerJoin(repos, eq(repos.id, documents.repoId))
      .where(visibleDocuments(where, options))
      .orderBy(byPath)
      .limit(rowsWanted),
    countDocs(db, repo, options),
  ]);
  return { total, docs: rows.map(toTreeRow) };
}

/** A repository's OKF guidelines file as stored. */
export interface GuidelinesDocument {
  /** Repo-relative path as stored (`docs/OKF-Guidelines.md`). */
  readonly path: string;
  readonly title: string;
  readonly description: string | null;
  /** Markdown body without frontmatter. */
  readonly body: string;
  readonly updatedAt: Date;
}

/**
 * The repository's guidelines file (mcp-agent-access spec `okf-authoring`): `okf-guidelines.md`
 * with the file name matched case-insensitively, first in the docs folder, else in its `guides`
 * folder. Folders are matched exactly as the docs folder is stored. When several spellings of the
 * name sit in one folder the lowest path in byte order wins. Null when there is none, when the
 * repository has no docs folder, or when it is unknown or hidden.
 */
export async function findOkfGuidelines(
  db: Db,
  repo: RepoRef,
  options: QueryOptions = {},
): Promise<GuidelinesDocument | null> {
  const where = await repoCondition(db, repo, options);
  if (where === null) return null;
  const inRoot = sql`lower(${documents.path}) = lower(${repos.docsPath} || ${`/${OKF_GUIDELINES_FILE}`})`;
  const inGuides = sql`lower(${documents.path}) = lower(${repos.docsPath} || ${`/${OKF_GUIDELINES_FOLDER}/${OKF_GUIDELINES_FILE}`})`;
  const rows = await db
    .select({
      path: documents.path,
      title: documents.title,
      description: documents.description,
      body: documents.body,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .innerJoin(repos, eq(repos.id, documents.repoId))
    .where(
      and(
        visibleDocuments(where, options),
        sql`${repos.docsPath} is not null`,
        or(inRoot, inGuides),
      ),
    )
    .orderBy(sql`case when ${inRoot} then 0 else 1 end`, byPath)
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { ...row };
}

/** Number of stored documents of a visible repository (0 when unknown or hidden). */
export async function countDocs(
  db: Db,
  repo: RepoRef,
  options: QueryOptions = {},
): Promise<number> {
  const where = await repoCondition(db, repo, options);
  if (where === null) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .innerJoin(repos, eq(repos.id, documents.repoId))
    .where(visibleDocuments(where, options));
  return Number(row?.count ?? 0) || 0;
}
