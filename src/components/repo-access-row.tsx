import type { ReactNode } from "react";

/** Row shape from the admin repos API. Local copy: components take data as props. */
export interface RepoAccessRow {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly isAllowed: boolean;
  /** Place in the admin-set starred order; null when not starred. */
  readonly starPosition: number | null;
  readonly isStarred: boolean;
  readonly syncStatus: "pending" | "ok" | "error";
}

const SYNC_LABEL: Record<RepoAccessRow["syncStatus"], string> = {
  ok: "Synced",
  pending: "Waiting for first sync",
  error: "Sync failed",
};

export const rowButton =
  "text-sm underline underline-offset-4 decoration-border hover:decoration-foreground disabled:opacity-50";
const gridCols = "md:grid-cols-[minmax(0,1fr)_6rem_11rem_minmax(11rem,auto)]";

export const repoLabel = (r: Pick<RepoAccessRow, "owner" | "name">): string =>
  `${r.owner}/${r.name}`;

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="inline-block size-3.5 align-[-2px]"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <path d="M8 1.5l2 4.2 4.5.6-3.3 3.1.8 4.5L8 11.7 4 13.9l.8-4.5L1.5 6.3l4.5-.6z" />
    </svg>
  );
}

export interface RepoLineProps {
  readonly repo: RepoAccessRow;
  /** This row's Star or Allow/Block request is in flight. */
  readonly busy: boolean;
  readonly onToggleStar: (repo: RepoAccessRow) => void;
  readonly onToggleAllowed: (repo: RepoAccessRow) => void;
  /** Starred rows: the drag handle, shown before the name. */
  readonly handle?: ReactNode;
  /** Starred rows: the Move up / Move down buttons, shown with the actions. */
  readonly moves?: ReactNode;
}

/** One repository row: name, access, sync state and its actions. */
export function RepoLine({
  repo: r,
  busy,
  onToggleStar,
  onToggleAllowed,
  handle,
  moves,
}: RepoLineProps) {
  const label = repoLabel(r);
  return (
    <div className={`grid items-center gap-x-4 gap-y-1 ${gridCols}`}>
      <div className="flex min-w-0 items-center gap-2">
        {handle}
        <div className="min-w-0">
          <span className={`break-all font-medium ${r.isAllowed ? "" : "text-muted-foreground"}`}>
            <span className="font-normal text-muted-foreground">{r.owner}/</span>
            {r.name}
          </span>
          {r.visibility === "private" ? (
            <span className="ml-2 text-xs text-muted-foreground">private</span>
          ) : null}
        </div>
      </div>
      <div className="text-sm">
        {r.isAllowed ? (
          <span className="text-muted-foreground">Visible</span>
        ) : (
          <span className="text-destructive">Blocked</span>
        )}
      </div>
      <div
        className={`text-sm ${r.syncStatus === "error" ? "text-destructive" : "text-muted-foreground"}`}
      >
        {SYNC_LABEL[r.syncStatus]}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 md:justify-end">
        {moves}
        <button
          type="button"
          disabled={busy}
          aria-pressed={r.isStarred}
          aria-label={`Star ${label}`}
          onClick={() => onToggleStar(r)}
          className={`${rowButton} inline-flex items-center gap-1`}
        >
          <StarIcon filled={r.isStarred} />
          Star
        </button>
        <button
          type="button"
          disabled={busy}
          aria-label={`${r.isAllowed ? "Block" : "Allow"} ${label}`}
          onClick={() => onToggleAllowed(r)}
          className={rowButton}
        >
          {r.isAllowed ? "Block" : "Allow"}
        </button>
      </div>
    </div>
  );
}
