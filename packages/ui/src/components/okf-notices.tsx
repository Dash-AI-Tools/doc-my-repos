import {
  buildNotices,
  type OkfDate,
  type OkfMeta,
  type OkfNotice,
} from "@docmyrepos/core/internal/okf-meta";
import { formatAbsoluteDate, formatAbsoluteTime } from "@docmyrepos/core/internal/time";

/**
 * Notices above the body of an OKF document (task 11.5, OKF spec "Metadata card": deprecated
 * document, stale document). Presentational and pure: the current time comes in as `now` (the
 * page passes the time it loaded the document, tests pass a fixed one), so the output depends on
 * nothing else.
 *
 * - `status: deprecated` and `status: draft` (any case) each give a notice; the status chip in the
 *   metadata card still shows the status exactly as written.
 * - A `stale_after` in the past gives a warning with the date and how long ago it was. A date in
 *   the future, or one that cannot be read, gives none (the card shows the date).
 * - Notices stack, status first. They are `role="note"`, not alerts: they are part of the
 *   document, not a live update. Colors are the `warning` and `destructive-muted` token pairs.
 */

const WARNING = "border-border bg-warning text-warning-foreground";
const DEPRECATED =
  "border-destructive-muted-border bg-destructive-muted text-destructive-muted-foreground";

/**
 * `today`, `1 day ago`, `12 days ago`, `in 3 days`; a year or more is counted in whole years
 * (`6 years ago`, `in 972 years`). Whole UTC days in, text out.
 */
export function daysPhrase(days: number, direction: "ago" | "in"): string {
  if (days <= 0) return "today";
  const years = Math.floor(days / 365);
  const unit =
    years >= 1
      ? years === 1
        ? "1 year"
        : `${years} years`
      : days === 1
        ? "1 day"
        : `${days} days`;
  return direction === "ago" ? `${unit} ago` : `in ${unit}`;
}

/** The date as a `<time>`, in the format its authored form had. Null date: the raw text. */
export function DateText({ field }: { readonly field: OkfDate }) {
  if (!field.valid || field.date === null) return <span>{field.raw}</span>;
  const iso = field.date.toISOString();
  const shown = field.dateOnly ? formatAbsoluteDate(field.date) : formatAbsoluteTime(field.date);
  return (
    <time dateTime={field.dateOnly ? iso.slice(0, 10) : iso} title={shown}>
      {shown}
    </time>
  );
}

function Notice({ notice }: { readonly notice: OkfNotice }) {
  switch (notice.kind) {
    case "deprecated":
      return (
        <div
          role="note"
          data-testid="okf-notice-deprecated"
          className={`rounded-md border p-3 text-sm ${DEPRECATED}`}
        >
          <p>
            <strong>This document is deprecated.</strong> It is kept for reference and may no longer
            be accurate.
          </p>
        </div>
      );
    case "draft":
      return (
        <div
          role="note"
          data-testid="okf-notice-draft"
          className={`rounded-md border p-3 text-sm ${WARNING}`}
        >
          <p>
            <strong>This document is a draft.</strong> Its content may be incomplete or change.
          </p>
        </div>
      );
    case "stale":
      return (
        <div
          role="note"
          data-testid="okf-notice-stale"
          className={`rounded-md border p-3 text-sm ${WARNING}`}
        >
          <p>
            <strong>This document may be out of date:</strong> it was due for review on{" "}
            <DateText field={notice.due} /> ({daysPhrase(notice.daysOverdue, "ago")}).
          </p>
        </div>
      );
  }
}

export function OkfNotices({ meta, now }: { readonly meta: OkfMeta; readonly now: Date }) {
  const notices = buildNotices(meta, now);
  if (notices.length === 0) return null;
  return (
    <div data-testid="okf-notices" className="mb-6 flex flex-col gap-3">
      {notices.map((notice) => (
        <Notice key={notice.kind} notice={notice} />
      ))}
    </div>
  );
}
