import Link from "next/link";

import { ERROR_ACTION } from "./error-panel";

/**
 * The page shown for an unknown repository (task 9.3, spec "Unknown repository"): not configured,
 * not synced yet, hidden by the visibility rule, or a URL that cannot name a repository. One
 * message for all of them, so the page reveals nothing about which. The HTTP status is 404 (set by
 * Next.js when the page calls `notFound()`).
 */
export function RepoNotFound() {
  return (
    <section
      aria-labelledby="not-found-heading"
      data-testid="repo-not-found"
      className="rounded-lg border border-border bg-card p-6 text-card-foreground"
    >
      <h1 id="not-found-heading" className="text-2xl font-bold tracking-tight">
        Repository not found
      </h1>
      <p className="mt-2 text-muted-foreground">
        This portal has no repository at this address. It may not be configured, it may not have
        been synced yet, or the address may be mistyped.
      </p>
      <div className="mt-4">
        <Link href="/" className={ERROR_ACTION}>
          Back to the home page
        </Link>
      </div>
    </section>
  );
}
