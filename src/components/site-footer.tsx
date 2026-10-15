import Link from "next/link";

import { REPO_URL } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="site-shell mx-auto flex w-full max-w-[88rem] flex-wrap justify-between gap-2 px-5 py-8 text-sm text-muted-foreground sm:px-8 lg:px-16">
        <span>
          Powered by{" "}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="footer-credit-link"
            className="text-muted-foreground underline hover:text-foreground"
          >
            DocMyRepos
          </a>
          {" · "}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="footer-star-link"
            className="text-muted-foreground no-underline hover:text-foreground"
            aria-label="Star DocMyRepos on GitHub"
          >
            <svg
              aria-hidden="true"
              focusable="false"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="mr-1 inline-block align-[-1px]"
            >
              <path d="M12 2.5 14.9 8.6 21.5 9.5 16.7 14.1 17.9 20.6 12 17.5 6.1 20.6 7.3 14.1 2.5 9.5 9.1 8.6Z" />
            </svg>
            Star
          </a>
        </span>
        <Link
          href="/status"
          prefetch={false}
          data-testid="footer-status-link"
          className="text-muted-foreground hover:text-foreground"
        >
          Sync status
        </Link>
      </div>
    </footer>
  );
}
