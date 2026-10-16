import { Fragment } from "react";

import { linkify } from "@/lib/comments";

/**
 * A comment's text (document-comments design decision 5). Comment text is untrusted: React renders
 * it as text, line breaks are kept by CSS, and the only elements produced are the links `linkify`
 * finds (`http(s)` only). No HTML is built from the text and nothing is interpreted.
 */
export function CommentText({ body }: { readonly body: string }) {
  return (
    <p data-testid="comment-text" className="whitespace-pre-wrap [overflow-wrap:anywhere]">
      {linkify(body).map((token, index) =>
        token.kind === "link" ? (
          <a
            key={index}
            href={token.href}
            rel="noopener noreferrer nofollow"
            target="_blank"
            className="text-link underline underline-offset-4 hover:text-link-hover"
          >
            {token.text}
          </a>
        ) : (
          <Fragment key={index}>{token.text}</Fragment>
        ),
      )}
    </p>
  );
}
