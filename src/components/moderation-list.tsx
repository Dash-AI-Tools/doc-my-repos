import Link from "next/link";

import {
  MODERATION_STATES,
  commentCount,
  moderationHref,
  type ModerationFilters,
  type ModerationRow,
  type ModerationState,
} from "@/lib/comments-moderation";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";

import { ModerationActions } from "./moderation-actions";

/**
 * The admin Comments list (document-comments task 5.1): filter links, one row per comment with
 * its excerpt as plain text, and the paging link. A server component: the filters and paging are
 * ordinary links, so the list works without script; only the buttons need it. No database access:
 * everything arrives as props.
 */

const STATE_LABEL: Record<ModerationState, string> = {
  live: "Live",
  deleted: "Deleted",
  orphaned: "Orphaned",
  blocked: "In a blocked repository",
};

const STATE_HELP: Record<ModerationState, string> = {
  live: "Shown to readers.",
  deleted: "Text removed.",
  orphaned: "Its document or repository no longer exists.",
  blocked: "Its repository is blocked, so readers cannot see it.",
};

const linkClass =
  "inline-flex min-h-6 items-center underline underline-offset-4 decoration-border hover:decoration-foreground";

function FilterLink({
  href,
  current,
  children,
}: {
  readonly href: string;
  readonly current: boolean;
  readonly children: string;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={current ? "true" : undefined}
      className={`inline-flex min-h-6 min-w-6 items-center justify-center ${
        current ? "font-semibold underline decoration-foreground underline-offset-4" : linkClass
      }`}
    >
      {children}
    </Link>
  );
}

export function ModerationFilterBar({ filters }: { readonly filters: ModerationFilters }) {
  return (
    <nav aria-label="Filter comments" className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-muted-foreground">State</span>
        <FilterLink
          href={moderationHref({ githubRepoId: filters.githubRepoId })}
          current={filters.state === null}
        >
          All
        </FilterLink>
        {MODERATION_STATES.map((state) => (
          <FilterLink
            key={state}
            href={moderationHref({ state, githubRepoId: filters.githubRepoId })}
            current={filters.state === state}
          >
            {state[0]!.toUpperCase() + state.slice(1)}
          </FilterLink>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Repository</span>
        {filters.githubRepoId === null ? (
          <span>All repositories (use “Only this repository” on a row to narrow)</span>
        ) : (
          <>
            <span>Repository {filters.githubRepoId}</span>
            <FilterLink href={moderationHref({ state: filters.state })} current={false}>
              Show all repositories
            </FilterLink>
          </>
        )}
      </div>
    </nav>
  );
}

function Row({
  row,
  filters,
  now,
  withActions,
}: {
  readonly row: ModerationRow;
  readonly filters: ModerationFilters;
  readonly now: Date;
  readonly withActions: boolean;
}) {
  const created = new Date(row.createdAt);
  const exact = formatAbsoluteTime(created);
  const where = row.repoLabel ?? `repository ${row.githubRepoId} (removed)`;
  const canDelete = !row.deleted && row.state !== "orphaned";
  const canPurge = row.state === "orphaned" || row.deleted;
  return (
    <li
      data-testid="moderation-row"
      data-state={row.state}
      className="flex min-w-0 flex-col gap-2 border-b border-border py-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="border border-foreground px-1.5 text-xs font-medium">
          {STATE_LABEL[row.state]}
          <span className="sr-only">. {STATE_HELP[row.state]}</span>
        </span>
        {row.asOrg ? (
          <span className="border border-border px-1.5 text-xs">Posted as the organization</span>
        ) : null}
        {row.isReply ? <span className="text-xs text-muted-foreground">Reply</span> : null}
        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{row.authorLabel}</span>
        <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
          {row.authorEmail ?? "(account removed)"}
        </span>
        <time dateTime={row.createdAt} title={exact} className="text-muted-foreground">
          {formatRelativeTime(created, now)}
          <span className="sr-only"> ({exact})</span>
        </time>
        {row.editedAt === null ? null : <span className="text-muted-foreground">edited</span>}
      </div>
      <p className="text-sm [overflow-wrap:anywhere]">
        {row.deleted ? (
          <span className="text-muted-foreground italic">
            {row.deletedByAdmin ? "Deleted by an admin" : "Deleted by its author"}; text removed.
          </span>
        ) : (
          <span data-testid="moderation-excerpt">{row.excerpt}</span>
        )}
      </p>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        {row.repoHref !== null && row.repoLabel !== null ? (
          <Link href={row.repoHref} prefetch={false} className={linkClass}>
            {where}
          </Link>
        ) : (
          <span>{where}</span>
        )}
        {row.docHref !== null ? (
          <Link href={row.docHref} prefetch={false} className={linkClass}>
            {row.path}
          </Link>
        ) : (
          <span className="[overflow-wrap:anywhere]">{row.path}</span>
        )}
        {filters.githubRepoId === null ? (
          <Link
            href={moderationHref({ state: filters.state, githubRepoId: row.githubRepoId })}
            prefetch={false}
            className={linkClass}
          >
            Only this repository
          </Link>
        ) : null}
      </p>
      {withActions ? (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
          {canDelete ? (
            <ModerationActions
              action={{ kind: "delete", id: row.id }}
              buttonLabel="Delete"
              subject={row.authorLabel}
              count={1}
              filters={filters}
            />
          ) : null}
          {canPurge ? (
            <ModerationActions
              action={{ kind: "purge-ids", ids: [row.id] }}
              buttonLabel="Remove permanently"
              subject={`comment by ${row.authorLabel}`}
              count={1}
              filters={filters}
            />
          ) : null}
          {row.state === "orphaned" && row.groupCount !== null && row.groupCount > 1 ? (
            <ModerationActions
              action={{ kind: "purge-document", githubRepoId: row.githubRepoId, path: row.path }}
              buttonLabel={`Remove all ${commentCount(row.groupCount)} of this document`}
              subject={row.path}
              count={row.groupCount}
              filters={filters}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function ModerationList({
  rows,
  filters,
  nextCursor,
  now,
}: {
  readonly rows: readonly ModerationRow[];
  readonly filters: ModerationFilters;
  readonly nextCursor: string | null;
  readonly now: string;
}) {
  const at = new Date(now);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {rows.length === 0 ? (
        <p data-testid="moderation-empty" className="text-muted-foreground">
          No comments match.
        </p>
      ) : (
        <ul aria-label="Comments" className="flex flex-col border-t border-foreground">
          {rows.map((row) => (
            <Row key={row.id} row={row} filters={filters} now={at} withActions />
          ))}
        </ul>
      )}
      <nav aria-label="Pages" className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {filters.cursor === null ? null : (
          <FilterLink
            href={moderationHref({ state: filters.state, githubRepoId: filters.githubRepoId })}
            current={false}
          >
            Back to the newest
          </FilterLink>
        )}
        {nextCursor === null ? null : (
          <FilterLink
            href={moderationHref({
              state: filters.state,
              githubRepoId: filters.githubRepoId,
              cursor: nextCursor,
            })}
            current={false}
          >
            Older comments
          </FilterLink>
        )}
      </nav>
    </div>
  );
}
