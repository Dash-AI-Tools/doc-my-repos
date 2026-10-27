import Link from "next/link";

import { ERROR_ACTION, ErrorPanel } from "./error-panel";

/**
 * Repository page error state: the repository could not be read (database unreachable or the
 * server is misconfigured). Fixed text; the real cause is in the server log. The retry link points
 * at the same page, which is rendered per request.
 */
export function RepoLoadError({ href }: { readonly href: string }) {
  return (
    <ErrorPanel
      title="This repository could not be loaded"
      testId="load-error"
      actions={
        <>
          <Link href={href} className={ERROR_ACTION}>
            Try again
          </Link>
          <Link href="/" className={ERROR_ACTION}>
            Back to the home page
          </Link>
        </>
      }
    >
      <p>
        The portal could not read this repository. The database may be unreachable or the server may
        be misconfigured. Nothing has been lost.
      </p>
      <p>
        Try again in a moment. If the problem continues, ask the administrator to check the server
        logs.
      </p>
    </ErrorPanel>
  );
}
