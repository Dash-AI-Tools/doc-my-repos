import {
  searchWords,
  selectSections,
  type SectionSource,
} from "@docmyrepos/core/internal/ask/sections";
import type { Db } from "../db/client";
import {
  getDocumentByPath,
  getRepo,
  searchDocuments,
  type QueryOptions,
  type SearchHit,
} from "../queries";
import { buildQueryMessages, parseQueries, type Exchange } from "./prompt";
import { ProviderError, type ProviderAdapter } from "./providers";

/**
 * Retrieval for Ask (ask-the-docs design decisions 1 and 2): the model writes up to three keyword
 * queries, the existing full-text search runs them through the shared visibility filter, hits are
 * merged by reciprocal rank, and the best sections of the top documents become numbered excerpts.
 * This module reads only through `packages/server/src/queries`. `retrieve` is the seam where an embeddings
 * implementation could replace the body later without touching callers.
 */

export const SEARCH_LIMIT_PER_QUERY = 5;
export const MAX_DOCUMENTS = 6;
/** Reciprocal rank fusion constant. */
const RRF_K = 60;
const QUERY_CALL_MAX_TOKENS = 150;
const QUERY_CALL_DEADLINE_MS = 15_000;

export interface RetrieveInput {
  readonly question: string;
  readonly history: readonly Exchange[];
  /** `owner/name`. A repository the reader cannot see is ignored (the question is unscoped). */
  readonly repo?: string | null;
}

/** A numbered excerpt, with everything the references list needs. All fields come from stored data. */
export interface Excerpt {
  readonly n: number;
  readonly repo: {
    readonly owner: string;
    readonly name: string;
    readonly docsPath: string | null;
  };
  readonly path: string;
  readonly title: string;
  readonly heading: {
    readonly text: string;
    readonly slug: string;
    readonly depth: number;
  } | null;
  readonly text: string;
}

export interface RetrieveResult {
  readonly excerpts: readonly Excerpt[];
  /** The queries that were searched. */
  readonly queries: readonly string[];
  /** Tokens spent on the query call, when the provider reported them. */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  /** The repository the search was limited to, or null. */
  readonly scope: string | null;
}

export interface RetrieveDeps {
  readonly db: Db;
  /** Writes the search queries. Its failure is not fatal: the raw question is searched instead. */
  readonly provider: ProviderAdapter;
  readonly options?: QueryOptions;
  /** Aborts the query call and the searches when the reader goes away. */
  readonly signal?: AbortSignal;
}

export type Retriever = (deps: RetrieveDeps, input: RetrieveInput) => Promise<RetrieveResult>;

const REPO_REF = /^([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})$/;

async function resolveScope(
  db: Db,
  repo: string | null | undefined,
  options: QueryOptions | undefined,
): Promise<string | null> {
  const match = typeof repo === "string" ? REPO_REF.exec(repo) : null;
  if (!match) return null;
  const found = await getRepo(db, match[1]!, match[2]!, options);
  return found ? `${found.owner}/${found.name}` : null;
}

/**
 * What is searched when the model gives no usable queries: the question's keywords (the index has
 * no stop-word removal, so the raw sentence would never match), or the question itself when it
 * has none.
 */
function fallbackQueries(question: string): string[] {
  const words = searchWords(question);
  return [words.length > 0 ? words.join(" ") : question];
}

async function writeQueries(
  deps: RetrieveDeps,
  input: RetrieveInput,
): Promise<{ queries: string[]; usage: RetrieveResult["usage"] }> {
  try {
    const reply = await deps.provider.completeOnce(
      buildQueryMessages(input.question, input.history),
      {
        maxTokens: QUERY_CALL_MAX_TOKENS,
        deadlineMs: QUERY_CALL_DEADLINE_MS,
        ...(deps.signal ? { signal: deps.signal } : {}),
      },
    );
    const usage =
      reply.inputTokens === null && reply.outputTokens === null
        ? null
        : { inputTokens: reply.inputTokens ?? 0, outputTokens: reply.outputTokens ?? 0 };
    return { queries: parseQueries(reply.text) ?? fallbackQueries(input.question), usage };
  } catch (error) {
    // The reader leaving is not a reason to carry on; anything else falls back to the question.
    if (error instanceof ProviderError && error.kind !== "aborted") {
      return { queries: fallbackQueries(input.question), usage: null };
    }
    throw error;
  }
}

/** Merges ranked hit lists by reciprocal rank, best first; ties keep the earlier query's order. */
export function mergeHits(lists: readonly (readonly SearchHit[])[]): SearchHit[] {
  const scores = new Map<string, { hit: SearchHit; score: number; first: number }>();
  let first = 0;
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const key = `${hit.repo.id}:${hit.doc.path}`;
      const entry = scores.get(key) ?? { hit, score: 0, first: first++ };
      entry.score += 1 / (RRF_K + rank + 1);
      scores.set(key, entry);
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .map((e) => e.hit);
}

export const retrieve: Retriever = async (deps, input) => {
  const scope = await resolveScope(deps.db, input.repo, deps.options);
  const { queries, usage } = await writeQueries(deps, input);

  const lists = await Promise.all(
    queries.map(async (q) => {
      const result = await searchDocuments(
        deps.db,
        { q, limit: SEARCH_LIMIT_PER_QUERY, ...(scope ? { repo: scope } : {}) },
        deps.options,
      );
      return result.hits;
    }),
  );
  const top = mergeHits(lists).slice(0, MAX_DOCUMENTS);

  // Whole documents through the visibility-filtered read. One that vanished is skipped.
  const loaded = await Promise.all(
    top.map(async (hit) => {
      const detail = await getDocumentByPath(
        deps.db,
        { owner: hit.repo.owner, name: hit.repo.name },
        hit.doc.path,
        deps.options,
      );
      return detail ? { hit, detail } : null;
    }),
  );
  const found = loaded.filter((l) => l !== null);

  const sources: SectionSource[] = found.map(({ detail }, i) => ({
    key: String(i),
    title: detail.title,
    body: detail.body,
    headings: detail.headings,
  }));
  const selected = selectSections(sources, [input.question, ...queries].join(" "));

  const excerpts: Excerpt[] = selected.map((section, i) => {
    const { hit, detail } = found[Number(section.key)]!;
    return {
      n: i + 1,
      repo: { owner: hit.repo.owner, name: hit.repo.name, docsPath: hit.repo.docsPath },
      path: detail.path,
      title: detail.title,
      heading: section.heading
        ? {
            text: section.heading.text,
            slug: section.heading.slug,
            depth: section.heading.depth,
          }
        : null,
      text: section.text,
    };
  });
  return { excerpts, queries, usage, scope };
};
