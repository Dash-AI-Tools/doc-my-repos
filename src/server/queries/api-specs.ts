import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { apiSpecs, repos } from "../db/schema";
import { isLookupText, MAX_PATH_CHARS, repoCondition, type RepoRef } from "./repo-ref";
import { visibleRepos, type QueryOptions } from "./visibility";

/**
 * API specification reads (openapi-reference design decision 8). Both join `repos` with
 * `visibleRepos(options)`, so a hidden repository's specs are never returned. `listApiSpecs`
 * leaves the `spec` column out (it can be large); `getApiSpec` returns one full spec.
 */

/** One stored spec without its parsed document, for the repository page. */
export interface ApiSpecSummary {
  readonly id: number;
  readonly repoId: number;
  /** Repo-relative path of the spec file. */
  readonly path: string;
  readonly format: "openapi" | "swagger";
  /** The `openapi` / `swagger` version string, e.g. "3.0.3". */
  readonly specVersion: string;
  readonly title: string;
  readonly apiVersion: string | null;
  readonly operationCount: number;
  readonly sizeBytes: number;
  readonly blobSha: string;
  readonly updatedAt: Date;
}

export interface ApiSpecDetail extends ApiSpecSummary {
  /** The parsed specification, untrusted. */
  readonly spec: Record<string, unknown>;
}

const SUMMARY = {
  id: apiSpecs.id,
  repoId: apiSpecs.repoId,
  path: apiSpecs.path,
  format: apiSpecs.format,
  specVersion: apiSpecs.specVersion,
  title: apiSpecs.title,
  apiVersion: apiSpecs.apiVersion,
  operationCount: apiSpecs.operationCount,
  sizeBytes: apiSpecs.sizeBytes,
  blobSha: apiSpecs.blobSha,
  updatedAt: apiSpecs.updatedAt,
};

/** API specs of a visible repository, ordered by path; empty when none or hidden. */
export async function listApiSpecs(
  db: Db,
  repo: RepoRef,
  options: QueryOptions = {},
): Promise<ApiSpecSummary[]> {
  const where = await repoCondition(db, repo, options);
  if (where === null) return [];
  return db
    .select(SUMMARY)
    .from(apiSpecs)
    .innerJoin(repos, eq(repos.id, apiSpecs.repoId))
    .where(and(visibleRepos(options), where))
    .orderBy(asc(apiSpecs.path));
}

/**
 * One full spec of a visible repository by its stored path. An exact match wins; failing that a
 * path that differs only in case matches (lowest path by code point first), so the loader can
 * redirect to the stored spelling. Null when absent, hidden or the path is unusable.
 */
export async function getApiSpec(
  db: Db,
  repo: RepoRef,
  path: string,
  options: QueryOptions = {},
): Promise<ApiSpecDetail | null> {
  if (!isLookupText(path, MAX_PATH_CHARS)) return null;
  const where = await repoCondition(db, repo, options);
  if (where === null) return null;
  const rows = await db
    .select({ ...SUMMARY, spec: apiSpecs.spec })
    .from(apiSpecs)
    .innerJoin(repos, eq(repos.id, apiSpecs.repoId))
    .where(and(visibleRepos(options), where, sql`lower(${apiSpecs.path}) = lower(${path})`))
    .orderBy(asc(apiSpecs.path))
    .limit(10);
  const exact = rows.find((r) => r.path === path);
  if (exact !== undefined) return exact;
  return rows.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))[0] ?? null;
}
