import "server-only";

import { buildDocsTree, type DocsTreeFolder, type DocsTreeRow } from "@/lib/docs-tree";
import {
  countTocRows,
  filterDocsRows,
  hasTocFilters,
  type TocData,
  type TocFilterState,
} from "@/lib/toc-filters";

import type { Db } from "./db/client";
import { getRepoFacets, type RepoDetail } from "./queries";

/**
 * The table of contents of a repository page or a document page with the type, tag and status
 * filters applied (tasks 11.2 and 11.3). Reads only through the query layer (`getRepoFacets`).
 *
 * - A repository that is not OKF (`repo.isOkf` as stored by the sync) has no OKF controls: the
 *   filters in the URL are ignored, the tree is the whole tree and `toc` is null. A stray
 *   `?type=` on a plain repository changes nothing.
 * - For an OKF repository the rows are filtered FIRST, then the tree is built from what is left,
 *   so a folder without a matching document is not in the tree. `keepPath` (the document being
 *   read) stays in the tree even when it does not match.
 * - The facet counts are the repository's, narrowed by the other kinds' filters (disjunctive).
 */
export interface TocLoad {
  /** The tree to show: filtered for an OKF repository, whole otherwise. */
  readonly tree: DocsTreeFolder;
  readonly toc: TocData | null;
}

export async function loadToc(
  db: Db,
  repo: RepoDetail,
  rows: readonly DocsTreeRow[],
  state: TocFilterState,
  keepPath: string | null = null,
): Promise<TocLoad> {
  if (!repo.isOkf) return { tree: buildDocsTree(rows, repo.docsPath), toc: null };
  const facets = await getRepoFacets(
    db,
    { id: repo.id },
    { type: state.types, tag: state.tags, status: state.statuses },
  );
  const shown = hasTocFilters(state) ? filterDocsRows(rows, state, keepPath) : rows;
  return {
    tree: buildDocsTree(shown, repo.docsPath),
    toc: {
      state,
      facets: { types: facets.types, tags: facets.tags, statuses: facets.statuses },
      counts: countTocRows(rows, state),
    },
  };
}
