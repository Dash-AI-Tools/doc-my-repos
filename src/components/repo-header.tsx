import Link from "next/link";

import { githubRepoUrl } from "@/lib/github-links";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";

import { documentCountLabel, okfBadgeLabel } from "./repo-card";

/**
 * Header of a repository space (task 9.3): breadcrumb, `owner/name` as the page title, badges
 * (private, OKF with its version), description, the link to the repository on GitHub, document
 * count and last synced time. Also the sync state: a repository whose last sync failed shows the
 * failure while its stored content stays on the page, and a repository that was never synced says
 * what is going on. Presentational: it renders what it is given, as text (React escapes it).
 * `RepoHeaderData` is the structural subset of the query layer's `RepoDetail` used here, because
 * components never import the server query layer.
 */

export interface RepoHeaderData {
  readonly owner: string;
  readonly name: string;
  readonly description: string | null;
  /** What GitHub reported at sync time; only used when it is a plain https URL. */
  readonly htmlUrl: string;
  readonly visibility: "public" | "private";
  readonly isOkf: boolean;
  readonly okfVersion: string | null;
  readonly syncStatus: "pending" | "ok" | "error";
  /** Fixed, safe text written by the sync (see `RepoSummary.syncError`). */
  readonly syncError: string | null;
  readonly lastSyncedAt: Date | null;
  readonly docCount: number;
}

export interface RepoHeaderProps {
  readonly repo: RepoHeaderData;
  /** The time "x ago" is measured against. The page passes the time of the read. */
  readonly now: Date;
}

const BADGE = "inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-xs font-medium";

export function RepoHeader({ repo, now }: RepoHeaderProps) {
  const syncedAt = repo.lastSyncedAt;
  const hasContent = syncedAt !== null || repo.docCount > 0;
  const description = repo.description?.trim() ?? "";
  return (
    <header data-testid="repo-header" className="flex min-w-0 flex-col gap-4">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <li>
            <Link href="/" className="text-foreground">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="break-all">
            {repo.owner}/{repo.name}
          </li>
        </ol>
      </nav>

      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-bold tracking-tight break-words">
            <span className="font-normal text-muted-foreground">{repo.owner}/</span>
            {repo.name}
          </h1>
          {repo.visibility === "private" || repo.isOkf ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {repo.visibility === "private" ? (
                <span
                  data-testid="private-badge"
                  className={`${BADGE} bg-private-badge text-private-badge-foreground`}
                >
                  Private
                </span>
              ) : null}
              {repo.isOkf ? (
                <span
                  data-testid="okf-badge"
                  className={`${BADGE} bg-okf-badge text-okf-badge-foreground`}
                >
                  <span className="truncate">{okfBadgeLabel(repo.okfVersion)}</span>
                </span>
              ) : null}
            </div>
          ) : null}
          <p
            data-testid="repo-description"
            className={
              description === ""
                ? "mt-3 text-muted-foreground italic"
                : "mt-3 break-words text-foreground"
            }
          >
            {description === "" ? "No description" : description}
          </p>
        </div>

        <a
          data-testid="github-link"
          href={githubRepoUrl(repo.htmlUrl, repo.owner, repo.name)}
          rel="noopener noreferrer"
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-md border border-input bg-secondary px-4 text-sm font-medium text-secondary-foreground no-underline hover:bg-accent"
        >
          <svg
            width="16"
            height="16"
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
          View on GitHub
        </a>
      </div>

      <p
        data-testid="repo-meta"
        className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground"
      >
        <span>{documentCountLabel(repo.docCount)}</span>
        {syncedAt !== null ? (
          <span>
            Last synced{" "}
            <time dateTime={syncedAt.toISOString()} title={formatAbsoluteTime(syncedAt)}>
              {formatRelativeTime(syncedAt, now)}
              <span className="sr-only"> ({formatAbsoluteTime(syncedAt)})</span>
            </time>
          </span>
        ) : (
          <span>Not synced yet</span>
        )}
      </p>

      {repo.syncStatus === "error" ? (
        <div
          role="status"
          data-testid="repo-sync-error"
          className="rounded-md border border-destructive-muted-border bg-destructive-muted p-3 text-sm text-destructive-muted-foreground"
        >
          <p className="font-medium">Last sync failed</p>
          {repo.syncError !== null && repo.syncError !== "" ? (
            <p className="mt-1 break-words">{repo.syncError}</p>
          ) : null}
          <p className="mt-1">
            {hasContent ? "Showing previously synced content." : "No content has been stored yet."}
          </p>
        </div>
      ) : null}

      {repo.syncStatus === "pending" ? (
        <div
          role="status"
          data-testid="repo-pending"
          className="rounded-md bg-warning p-3 text-sm text-warning-foreground"
        >
          <p className="font-medium">Waiting for the first sync</p>
          <p className="mt-1">
            This repository is known to the portal but has not been synced yet, so there is no
            content to show. It appears here once a sync has finished.
          </p>
        </div>
      ) : null}
    </header>
  );
}
