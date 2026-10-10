import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { DocBody } from "@/components/doc-body";
import { DocBreadcrumb } from "@/components/doc-breadcrumb";
import { DocPager } from "@/components/doc-pager";
import { DocsNavSlot } from "@/components/docs-nav-slot";
import { OutlineNav } from "@/components/outline-nav";
import { RepoLoadError } from "@/components/repo-load-error";
import { docUrl, repoUrl } from "@/lib/routes";
import { buildFilterQuery } from "@/lib/search-params";
import { buildTocFilterView, parseTocFilters, withFilterQuery } from "@/lib/toc-filters";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { loadDocPage, type DocPageOk } from "@/server/doc-page";

/**
 * Document page `/<owner>/<repo>/docs/<path>` (task 9.7, spec "Document page navigation"): the
 * rendered document, its "On this page" outline, a link to the source on GitHub and previous/next
 * links in table-of-contents order, with the table of contents in a sidebar. Read from Postgres
 * only (never GitHub); rendered per request, because a sync can change it at any time.
 *
 * States: ok; redirect to the canonical address (other case, or a folder that has an `index.md`);
 * not found (HTTP 404 through `notFound()`, rendered by the segment's `not-found.tsx`, for an
 * unknown, hidden or malformed address); and the in-page error state for an unreachable database or
 * unusable configuration. Unexpected errors go to `src/app/error.tsx`.
 *
 * Page title: the page's `h1` is the document title. A body that opens with an `h1` repeating the
 * title has that heading hidden (`DocBody`), so there is one `h1`; a body whose first heading
 * differs (a frontmatter `title`) is shown as written.
 *
 * Layout: the content column, then the sidebar (outline, then table of contents) after it in the
 * DOM, so keyboard users reach the document first. The sidebar sticks to the viewport on large
 * screens and is collapsed on small ones.
 */
export const dynamic = "force-dynamic";

type Params = Promise<{ owner: string; repo: string; path: string[] }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * The catch-all segments of the address, percent-decoded exactly once, or null when an escape is
 * malformed (such an address names nothing).
 *
 * Next.js 16.4 hands the page the raw (still percent-encoded) segments, but `generateMetadata`
 * the decoded ones. So the page decodes (`100%25%20done` is the file `100% done`) and
 * `generateMetadata` uses its segments as given. `e2e/doc-page.spec.ts` ("a file whose name has a
 * space and a percent sign") checks both the page and its title, so a Next.js release that makes
 * the two agree fails there rather than showing a wrong title.
 */
function decodeSegments(raw: readonly string[]): string[] | null {
  try {
    return raw.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/** One read per request, shared by `generateMetadata` and the page. */
const load = cache((owner: string, repo: string, key: string, filterQuery: string) =>
  loadDocPage(
    owner,
    repo,
    JSON.parse(key) as string[],
    {},
    parseTocFilters(new URLSearchParams(filterQuery)),
  ),
);

/**
 * `filterQuery` is the canonical `type=..&tag=..&status=..` of the URL (tasks 11.2 and 11.3): it
 * only narrows the sidebar's table of contents of an OKF repository.
 */
const loadFor = (owner: string, repo: string, segments: readonly string[], filterQuery: string) =>
  load(owner, repo, JSON.stringify(segments), filterQuery);

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}): Promise<Metadata> {
  const { owner, repo, path } = await params;
  // The title comes from the stored document, never from the address as typed.
  const data = await loadFor(
    owner,
    repo,
    path,
    buildFilterQuery(parseTocFilters(await searchParams)),
  );
  if (data.status === "ok") {
    // `description` only when the document has one: an explicit undefined would replace the
    // site description instead of inheriting it.
    return {
      title: `${data.doc.title} · ${data.repo.owner}/${data.repo.name}`,
      ...(data.doc.description === null ? {} : { description: data.doc.description }),
      alternates: { canonical: data.url },
    };
  }
  if (data.status === "not_found") return { title: "Document not found · DocMyRepos" };
  return { title: "DocMyRepos" };
}

function pagerLink(
  doc: { path: string; title: string } | null,
  data: DocPageOk,
): { title: string; href: string } | null {
  if (doc === null) return null;
  const href = docUrl(data.repo.owner, data.repo.name, doc.path, data.repo.docsPath);
  return href === null ? null : { title: doc.title, href };
}

const BUTTON =
  "inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-input bg-secondary px-3 text-sm font-medium text-secondary-foreground no-underline hover:bg-accent";

export default async function DocPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { owner, repo: name, path: rawPath } = await params;
  const path = decodeSegments(rawPath);
  if (path === null) notFound();
  const filterQuery = buildFilterQuery(parseTocFilters(await searchParams));
  const data = await loadFor(owner, name, path, filterQuery);
  if (data.status === "not_found") notFound();
  // A redirect to the canonical address keeps the filters of the sidebar.
  if (data.status === "redirect") redirect(withFilterQuery(data.to, filterQuery));
  if (data.status === "error") {
    return (
      <RepoLoadError
        href={`${repoUrl(owner, name)}/docs/${path.map(encodeURIComponent).join("/")}`}
      />
    );
  }

  const { repo, doc, body, notice, outline, navTree, toc, crumbs, sourceUrl, loadedAt } = data;
  const filters =
    toc === null
      ? null
      : buildTocFilterView({
          basePath: data.url,
          state: toc.state,
          facets: toc.facets,
          counts: toc.counts,
        });
  const syncedAt = repo.lastSyncedAt;
  const awaitingSync = repo.syncStatus === "pending" || repo.lastSyncedAt === null;
  const description = doc.description?.trim() ?? "";

  return (
    <div className="flex flex-col gap-6">
      <DocBreadcrumb owner={repo.owner} repo={repo.name} crumbs={crumbs} title={doc.title} />
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <article
            aria-labelledby="doc-title"
            data-testid="doc-article"
            className="min-w-0 rounded-lg border border-border bg-card p-6 text-card-foreground"
          >
            <header data-testid="doc-header" className="flex flex-col gap-3">
              <h1 id="doc-title" className="text-3xl font-bold tracking-tight break-words">
                {doc.title}
              </h1>
              {description !== "" ? (
                <p
                  data-testid="doc-description"
                  className="text-lg break-words text-muted-foreground"
                >
                  {description}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                {sourceUrl !== null ? (
                  <a
                    data-testid="source-link"
                    href={sourceUrl}
                    rel="noopener noreferrer"
                    className={BUTTON}
                  >
                    View source on GitHub
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M14 3h7v7" />
                      <path d="M21 3 10 14" />
                      <path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
                    </svg>
                  </a>
                ) : null}
                <code data-testid="doc-source-path" className="font-mono break-all">
                  {doc.path}
                </code>
                {syncedAt !== null ? (
                  <span>
                    Last synced{" "}
                    <time dateTime={syncedAt.toISOString()} title={formatAbsoluteTime(syncedAt)}>
                      {formatRelativeTime(syncedAt, loadedAt)}
                      <span className="sr-only"> ({formatAbsoluteTime(syncedAt)})</span>
                    </time>
                  </span>
                ) : null}
              </div>
            </header>

            {notice !== null ? (
              <p
                data-testid="doc-notice"
                className="mt-4 rounded-md bg-warning p-3 text-sm text-warning-foreground"
              >
                {notice}
              </p>
            ) : null}

            <div className="mt-6">
              <DocBody body={body} />
            </div>
          </article>

          <DocPager previous={pagerLink(data.previous, data)} next={pagerLink(data.next, data)} />
        </div>

        <div
          data-testid="doc-sidebar"
          className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:p-1"
        >
          <OutlineNav items={outline} />
          <DocsNavSlot
            variant="sidebar"
            docCount={repo.docCount}
            tree={navTree}
            owner={repo.owner}
            repo={repo.name}
            currentPath={doc.path}
            awaitingSync={awaitingSync}
            filters={filters}
          />
        </div>
      </div>
    </div>
  );
}
