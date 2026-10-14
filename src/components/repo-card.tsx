import Link from "next/link";

import { repoUrl } from "@/lib/routes";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";

/**
 * One repository card on the home page (task 9.2, spec "Home page repository grid" and "Private
 * repository indication"). Presentational: it renders what it is given. The page passes the
 * `RepoSummary` rows of `listRepos`; this interface is the structural subset used here so that
 * components never import the server query layer.
 *
 * Markup: the whole card is one link (a "stretched link": the title anchor's `::after` covers the
 * card), so there is a single tab stop and no nested interactive elements. The focus ring is drawn
 * on that pseudo-element, around the whole card. The badges and the footer are plain text. Links
 * are not prefetched: the grid can hold hundreds of cards and each target is a database-backed
 * page.
 *
 * Text that comes from third-party repositories (description, OKF version) is rendered as text by
 * React and is clipped (line clamp, truncation) so it cannot stretch the grid.
 */

export interface RepoCardData {
  readonly owner: string;
  readonly name: string;
  readonly description: string | null;
  readonly visibility: "public" | "private";
  readonly isOkf: boolean;
  readonly okfVersion: string | null;
  readonly syncStatus: "pending" | "ok" | "error";
  /** Fixed, safe text written by the sync (see `RepoSummary.syncError`). */
  readonly syncError: string | null;
  readonly lastSyncedAt: Date | null;
  readonly docCount: number;
}

export interface RepoCardProps {
  readonly repo: RepoCardData;
  /** The time "x ago" is measured against. The page passes the time of the read. */
  readonly now: Date;
}

/** `OKF v0.2`; a version that already starts with `v` is not doubled. */
export function okfBadgeLabel(okfVersion: string | null): string {
  const version = okfVersion?.trim() ?? "";
  if (version === "") return "OKF";
  return `OKF ${/^v/i.test(version) ? version : `v${version}`}`;
}

export function documentCountLabel(count: number): string {
  if (count === 1) return "1 document";
  return count === 0 ? "No documents" : `${count} documents`;
}

const BADGE = "inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-xs font-medium";

export function RepoCard({ repo, now }: RepoCardProps) {
  const hasContent = repo.lastSyncedAt !== null || repo.docCount > 0;
  const syncedAt = repo.lastSyncedAt;
  return (
    <li
      data-testid="repo-card"
      data-sync-status={repo.syncStatus}
      className="relative flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground hover:border-input"
    >
      <h3 className="text-base font-semibold break-words">
        <Link
          href={repoUrl(repo.owner, repo.name)}
          prefetch={false}
          className="text-card-foreground no-underline after:absolute after:inset-0 after:rounded-lg hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
        >
          <span className="font-normal text-muted-foreground">{repo.owner}/</span>
          {repo.name}
        </Link>
      </h3>

      {repo.visibility === "private" || repo.isOkf ? (
        <div className="flex flex-wrap gap-2">
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
        className={
          repo.description === null || repo.description.trim() === ""
            ? "text-sm text-muted-foreground italic"
            : "line-clamp-3 text-sm break-words text-card-foreground"
        }
      >
        {repo.description === null || repo.description.trim() === ""
          ? "No description"
          : repo.description}
      </p>

      {repo.syncStatus === "error" ? (
        <div
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
          data-testid="repo-pending"
          className="rounded-md bg-warning p-3 text-sm text-warning-foreground"
        >
          <p className="font-medium">Waiting for the first sync</p>
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 pt-1 text-sm text-muted-foreground">
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
      </div>
    </li>
  );
}
