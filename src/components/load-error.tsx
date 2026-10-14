import Link from "next/link";

import { ERROR_ACTION, ErrorPanel } from "./error-panel";

/**
 * Home page error state: the repository list could not be read (database unreachable or the
 * server is misconfigured). Fixed text; the real cause is in the server log. The retry link is a
 * `Link`: pages are dynamic, so navigating to the page that is already open fetches it again.
 */
export function LoadErrorState() {
  return (
    <ErrorPanel
      title="Repositories could not be loaded"
      testId="load-error"
      actions={
        <Link href="/" className={ERROR_ACTION}>
          Try again
        </Link>
      }
    >
      <p>
        The portal could not read its repository list. The database may be unreachable or the server
        may be misconfigured. Nothing has been lost.
      </p>
      <p>
        Try again in a moment. If the problem continues, ask the administrator to check the server
        logs.
      </p>
    </ErrorPanel>
  );
}
