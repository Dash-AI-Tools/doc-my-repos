import { commentsLabel, type DocCommentsData } from "@/lib/comments-view";

import { CommentsClient } from "./comments-client";

type Ready = Extract<DocCommentsData, { status: "ready" }>;

/**
 * The Comments section after the document body (document-comments task 4.1). A server component:
 * the data comes from `loadDocComments` as props (this file never touches the database). The threads are rendered as static markup by `CommentsClient`'s
 * first render, so they read without script. Renders nothing when comments are off or nobody is
 * signed in, and a short notice when the read failed. The section is hidden in read mode
 * (`data-read-hide`).
 */
export function CommentsSection({ data }: { readonly data: DocCommentsData }) {
  if (data.status === "disabled" || data.status === "hidden") return null;
  if (data.status === "unavailable") {
    return (
      <section
        id="comments"
        data-testid="comments-section"
        data-read-hide
        aria-labelledby="comments-heading"
        className="scroll-mt-24 border-t border-border pt-8"
      >
        <h2 id="comments-heading" className="text-2xl font-bold tracking-[-0.02em]">
          Comments
        </h2>
        <p className="mt-3 text-muted-foreground">Comments are temporarily unavailable.</p>
      </section>
    );
  }
  return <ReadySection data={data} />;
}

function ReadySection({ data }: { readonly data: Ready }) {
  const { comments, openThreads } = data.counts;
  return (
    <section
      id="comments"
      data-testid="comments-section"
      data-read-hide
      aria-labelledby="comments-heading"
      className="flex min-w-0 scroll-mt-24 flex-col gap-6 border-t border-border pt-8"
    >
      <div className="flex flex-col gap-1">
        <h2
          id="comments-heading"
          tabIndex={-1}
          className="text-2xl font-bold tracking-[-0.02em] outline-offset-4"
        >
          Comments
        </h2>
        <p data-testid="comments-summary" className="text-sm text-muted-foreground">
          {commentsLabel(comments)}
          {openThreads === 1 ? ", 1 open thread" : `, ${openThreads} open threads`}
        </p>
      </div>
      <CommentsClient
        repo={data.repo}
        path={data.path}
        initialThreads={data.threads}
        initialCursor={data.nextCursor}
        viewer={data.viewer}
        orgName={data.orgName}
        loadedAt={data.loadedAt}
      />
    </section>
  );
}
