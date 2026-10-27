import Link from "next/link";

/** The path that opens the GitHub setup instructions on the Workspace configuration page. */
export const SETUP_HREF = "/admin/workspace?setup=1";

/**
 * Info banner for an administrator of a workspace without a GitHub App. The whole banner is one
 * link: it opens the Workspace configuration page with the setup instructions pop-up showing.
 */
export function SetupBanner() {
  return (
    <Link
      href={SETUP_HREF}
      data-testid="setup-banner"
      className="flex min-h-6 items-center gap-3 rounded-md border border-border bg-muted px-4 py-3 text-sm hover:border-foreground"
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className="shrink-0">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 7.2v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8" cy="4.8" r="0.95" fill="currentColor" />
      </svg>
      <span>
        <strong>Connect DocMyRepos to GitHub.</strong> Nothing syncs until a GitHub App is set up.{" "}
        <span className="underline underline-offset-4">Show me the steps</span>
      </span>
    </Link>
  );
}
