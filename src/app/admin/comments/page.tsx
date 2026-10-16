import { ModerationFilterBar, ModerationList } from "@/components/moderation-list";
import { loadModeration } from "@/server/admin/comments";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const count = (value: string | string[] | undefined): number | null => {
  const text = Array.isArray(value) ? value[0] : value;
  return text !== undefined && /^\d{1,6}$/.test(text) ? Number(text) : null;
};

/** Admin comment moderation (guarded by `src/app/admin/layout.tsx`). */
export default async function AdminCommentsPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const data = await loadModeration(raw);
  const removed = count(raw.removed);
  const deleted = raw.deleted === "1";
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Comments</h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Comments from every repository, newest first, including blocked repositories and comments
          whose document no longer exists. Deleting removes the text. Permanent removal also removes
          the row and cannot be undone; it is only allowed for deleted and orphaned comments.
        </p>
      </div>
      {removed !== null ? (
        <p
          role="status"
          data-testid="moderation-notice"
          className="border border-foreground p-3 text-sm"
        >
          {removed === 1
            ? "1 comment removed permanently."
            : `${removed} comments removed permanently.`}
        </p>
      ) : deleted ? (
        <p
          role="status"
          data-testid="moderation-notice"
          className="border border-foreground p-3 text-sm"
        >
          Comment deleted.
        </p>
      ) : null}
      {data.status === "unavailable" ? (
        <p role="alert" className="text-muted-foreground">
          Comments could not be loaded. Try again in a moment.
        </p>
      ) : (
        <>
          {data.enabled ? null : (
            <p
              data-testid="comments-off-notice"
              className="border border-border bg-muted p-3 text-sm"
            >
              Comments are off (<code>comments.enabled</code> is false). Readers see no comments and
              the comment API answers 404. Stored comments are kept, and you can still remove them
              permanently here.
            </p>
          )}
          <ModerationFilterBar filters={data.filters} />
          <ModerationList
            rows={data.rows}
            filters={data.filters}
            nextCursor={data.nextCursor}
            now={data.now}
          />
        </>
      )}
    </div>
  );
}
