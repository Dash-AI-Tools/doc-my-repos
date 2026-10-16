import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { ChangeLog } from "@/components/change-log";
import { CommentCountLink } from "@/components/comment-count-link";
import { CommentsSection } from "@/components/comments-section";
import { DocBody } from "@/components/doc-body";
import { DocBreadcrumb } from "@/components/doc-breadcrumb";
import { DocNavBar } from "@/components/doc-nav-bar";
import { DocPager } from "@/components/doc-pager";
import { DocReader } from "@/components/doc-reader";
import { DocsNavSlot } from "@/components/docs-nav-slot";
import { OkfMetadataCard } from "@/components/okf-metadata-card";
import { OkfNotices } from "@/components/okf-notices";
import { OutlineNav } from "@/components/outline-nav";
import { ReaderGrid } from "@/components/reader-grid";
import { ReadModeTarget } from "@/components/read-mode-target";
import { RepoLoadError } from "@/components/repo-load-error";
import { buildOkfMeta } from "@/lib/okf-meta";
import { docUrl, repoUrl } from "@/lib/routes";
import { buildFilterQuery } from "@/lib/search-params";
import { buildTocFilterView, parseTocFilters, withFilterQuery } from "@/lib/toc-filters";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import type { NavView } from "@/lib/reading-prefs";
import { loadDocComments } from "@/server/doc-comments";
import { loadDocPage, type DocPageOk } from "@/server/doc-page";
import { readNavView } from "@/server/nav-view";

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
 * OKF (tasks 11.4 to 11.6), for a repository that is OKF only (a plain repository shows no OKF UI):
 * the metadata card between the header and the body, deprecation, draft and stale notices right
 * above the body, and the reserved `log.md` framed as a change log. The card is for typed
 * documents: the reserved `index.md` and `log.md` get no card. Time-dependent output (the stale
 * warning) uses `loadedAt`, the time the page was loaded.
 *
 * Layout (spec "docs-reader-layout"): the breadcrumb sits in the content column, above the title,
 * so it lines up with the document and the side columns start level with it. The document first in the DOM, then the headings, then the
 * docs structure, so keyboard users reach the document first. From `xl` three columns (structure,
 * document, headings), both rails sticky; from `lg` two (the headings become a dropdown in the
 * document bar); below that one column, with the structure in a slide-in panel opened from the
 * bar. Without JavaScript the headings and the structure stay as lists after the document.
 *
 * Comments (document-comments tasks 4.1 and 4.5): the Comments section follows the article in the
 * document column, and the header carries a count link to it. Both come from `loadDocComments`
 * (the query layer, never GitHub), render nothing when `comments.enabled` is false, and are hidden
 * in read mode with `data-read-hide`.
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
const load = cache((owner: string, repo: string, key: string, filterQuery: string, view: NavView) =>
  loadDocPage(
    owner,
    repo,
    JSON.parse(key) as string[],
    {},
    parseTocFilters(new URLSearchParams(filterQuery)),
    view,
  ),
);

/**
 * `filterQuery` is the canonical `type=..&tag=..&status=..` of the URL (tasks 11.2 and 11.3): it
 * only narrows the sidebar's table of contents of an OKF repository. The reader's navigation view
 * (OKF or Tree, docs-nav-views) comes from its cookie, so the first HTML already shows it.
 */
const loadFor = async (
  owner: string,
  repo: string,
  segments: readonly string[],
  filterQuery: string,
) => load(owner, repo, JSON.stringify(segments), filterQuery, await readNavView());

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
    // Absolute: the address already names the page, and the e2e suite asserts it exactly.
    return {
      title: { absolute: `${data.doc.title} · ${data.repo.owner}/${data.repo.name}` },
      ...(data.doc.description === null ? {} : { description: data.doc.description }),
      alternates: { canonical: data.url },
    };
  }
  if (data.status === "not_found") return { title: "Document not found" };
  return {};
}

function pagerLink(
  doc: { path: string; title: string } | null,
  data: DocPageOk,
): { title: string; href: string } | null {
  if (doc === null) return null;
  const href = docUrl(data.repo.owner, data.repo.name, doc.path, data.repo.docsPath);
  return href === null ? null : { title: doc.title, href };
}

const SOURCE_LINK =
  "inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground";

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

  const { repo, doc, body, notice, outline, navTree, toc, view, crumbs, sourceUrl, loadedAt } =
    data;
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
  const okfMeta = repo.isOkf
    ? buildOkfMeta(doc.frontmatter, {
        type: doc.type,
        tags: doc.tags,
        status: doc.status,
        description: doc.description,
      })
    : null;
  const showCard = okfMeta !== null && doc.reserved === null && okfMeta.hasContent;
  // Reserved index.md/log.md are not typed concepts: no card and no status or staleness notices.
  const noticeMeta = doc.reserved === null ? okfMeta : null;
  const isChangeLog = repo.isOkf && doc.reserved === "log";
  // The card has a Description row, so the header does not repeat it.
  const comments = await loadDocComments(repo.owner, repo.name, doc.path);
  const description =
    showCard && okfMeta.description !== null ? "" : (doc.description?.trim() ?? "");

  return (
    <DocReader>
      <ReadModeTarget />
      <DocNavBar hasOutline={outline.length > 0}>
        <OutlineNav items={outline} variant="menu" />
      </DocNavBar>
      <ReaderGrid
        outline={outline}
        nav={
          <DocsNavSlot
            docCount={repo.docCount}
            tree={navTree}
            owner={repo.owner}
            repo={repo.name}
            currentPath={doc.path}
            awaitingSync={awaitingSync}
            filters={filters}
            okf={repo.isOkf}
            view={view}
          />
        }
      >
        <div className="flex flex-col gap-8">
          <DocBreadcrumb owner={repo.owner} repo={repo.name} crumbs={crumbs} title={doc.title} />
          <article
            aria-labelledby="doc-title"
            data-testid="doc-article"
            data-read-article
            tabIndex={-1}
            className="min-w-0 text-card-foreground"
          >
            <header data-testid="doc-header" className="flex flex-col gap-4">
              <h1
                id="doc-title"
                className="text-4xl leading-[1.05] font-bold tracking-[-0.035em] break-words sm:text-5xl xl:text-6xl"
              >
                {doc.title}
              </h1>
              {description !== "" ? (
                <p
                  data-testid="doc-description"
                  className="text-xl leading-relaxed break-words text-muted-foreground"
                >
                  {description}
                </p>
              ) : null}
              <div
                data-read-hide
                className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-border pb-6 text-sm text-muted-foreground"
              >
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
                {comments.status === "ready" ? (
                  <CommentCountLink count={comments.counts.comments} />
                ) : null}
                {sourceUrl !== null ? (
                  <a
                    data-testid="source-link"
                    href={sourceUrl}
                    rel="noopener noreferrer"
                    className={SOURCE_LINK}
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
              </div>
            </header>

            {showCard ? (
              <OkfMetadataCard
                meta={okfMeta}
                now={loadedAt}
                repoPath={repoUrl(repo.owner, repo.name)}
              />
            ) : null}

            {notice !== null ? (
              <p
                data-testid="doc-notice"
                className="mt-4 rounded-md bg-warning p-3 text-sm text-warning-foreground"
              >
                {notice}
              </p>
            ) : null}

            <div className="mt-8">
              {noticeMeta !== null ? <OkfNotices meta={noticeMeta} now={loadedAt} /> : null}
              {isChangeLog ? (
                <ChangeLog>
                  <DocBody body={body} />
                </ChangeLog>
              ) : (
                <DocBody body={body} />
              )}
            </div>
          </article>
          <CommentsSection data={comments} />
        </div>

        <DocPager previous={pagerLink(data.previous, data)} next={pagerLink(data.next, data)} />
      </ReaderGrid>
    </DocReader>
  );
}
