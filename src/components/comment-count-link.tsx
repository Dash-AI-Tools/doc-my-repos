import { commentsLabel } from "@/lib/comments-view";

/** The comment count in the document header, a link to the Comments section (`#comments`). */
export function CommentCountLink({ count }: { readonly count: number }) {
  return (
    <a
      data-testid="comment-count-link"
      href="#comments"
      className="inline-flex min-h-6 shrink-0 items-center text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
    >
      {commentsLabel(count)}
    </a>
  );
}
