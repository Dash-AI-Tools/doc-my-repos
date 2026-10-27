import Link from "next/link";

import { githubRepoUrl } from "@docmyrepos/core/internal/github-links";
import {
  plural,
  repoStatusChip,
  runOutcomeLabel,
  TONE_CLASSES,
  triggerLabel,
  type RepoRunOutcome,
  type SyncTrigger,
} from "@docmyrepos/core/internal/sync-status";
import type { SyncWarningView } from "@docmyrepos/core/internal/sync-warnings";
import { formatAbsoluteTime, formatRelativeTime } from "@docmyrepos/core/internal/time";

import { documentCountLabel, okfBadgeLabel } from "./repo-card";
import { SyncWarningsNotice } from "./sync-warnings-notice";

/**
 * Header of a repository space (task 9.3): breadcrumb, `owner/name` as the page title, badges
 * (private, OKF with its version), description, the link to the repository on GitHub, document
 * count and last synced time. Also the sync state: a repository whose last sync failed shows the
 * failure while its stored content stays on the page, and a repository that was never synced says
 * what is going on. Presentational: it renders what it is given, as text (React escapes it).
 *
 * Sync state (tasks 12.2 and 12.3): a status chip (synced, synced with warnings, sync failed,
 * pending), the repository's last sync run (trigger, when, outcome, warnings), and the files the
 * last sync left out (document or size cap) in a disclosure.
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
  /** Files the last sync left out (task 12.3); absent or empty when none. */
  readonly syncWarnings?: readonly SyncWarningView[];
}

/** The repository's latest sync run (structural subset of the query layer's `RepoLastRun`). */
export interface RepoHeaderLastRun {
  readonly trigger: SyncTrigger;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly outcome: RepoRunOutcome;
  readonly warnings: number;
}

export interface RepoHeaderProps {
  readonly repo: RepoHeaderData;
  /** The repository's latest recorded run; null or absent when none is recorded. */
  readonly lastRun?: RepoHeaderLastRun | null;
  /** The time "x ago" is measured against. The page passes the time of the read. */
  readonly now: Date;
  /** Ask is on: the link to `/ask` limited to this repository. Absent or null shows none. */
  readonly askHref?: string | null;
}

const BADGE = "inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-xs font-medium";

function TimeText({ date, now }: { readonly date: Date; readonly now: Date }) {
  return (
    <time dateTime={date.toISOString()} title={formatAbsoluteTime(date)}>
      {formatRelativeTime(date, now)}
      <span className="sr-only"> ({formatAbsoluteTime(date)})</span>
    </time>
  );
}

export function RepoHeader({ repo, now, lastRun = null, askHref = null }: RepoHeaderProps) {
  const syncedAt = repo.lastSyncedAt;
  const warnings = repo.syncWarnings ?? [];
  const chip = repoStatusChip(repo.syncStatus, warnings.length);
  const runAt = lastRun === null ? null : (lastRun.finishedAt ?? lastRun.startedAt);
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
          <h1 className="text-4xl leading-[1.05] font-bold tracking-[-0.035em] break-words sm:text-5xl">
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

        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
          {askHref !== null ? (
            <Link
              data-testid="ask-about-repo"
              href={askHref}
              className="inline-flex min-h-6 items-center text-sm font-medium underline underline-offset-4"
            >
              Ask about this repository
            </Link>
          ) : null}
          <a
            data-testid="github-link"
            href={githubRepoUrl(repo.htmlUrl, repo.owner, repo.name)}
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-2 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
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
      </div>

      <p
        data-testid="repo-meta"
        className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground"
      >
        <span
          data-testid="repo-sync-status"
          data-tone={chip.tone}
          className={`${BADGE} ${TONE_CLASSES[chip.tone]}`}
        >
          {chip.label}
        </span>
        <span>{documentCountLabel(repo.docCount)}</span>
        {syncedAt !== null ? (
          <span data-testid="repo-last-synced">
            Last synced <TimeText date={syncedAt} now={now} />
          </span>
        ) : (
          <span data-testid="repo-last-synced">Not synced yet</span>
        )}
        {lastRun !== null && runAt !== null ? (
          <span data-testid="repo-last-run">
            Last run: {triggerLabel(lastRun.trigger)}, <TimeText date={runAt} now={now} />,{" "}
            {runOutcomeLabel(lastRun.outcome)}
            {lastRun.warnings > 0 ? `, ${plural(lastRun.warnings, "warning")}` : ""}
          </span>
        ) : null}
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
          {syncedAt !== null ? (
            <p className="mt-1" data-testid="repo-sync-error-stored">
              Last successful sync: <TimeText date={syncedAt} now={now} />.
            </p>
          ) : null}
        </div>
      ) : null}

      <SyncWarningsNotice warnings={warnings} />

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
