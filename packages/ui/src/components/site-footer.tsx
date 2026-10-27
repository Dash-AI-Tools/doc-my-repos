import Link from "next/link";

import type { LinkItem } from "@docmyrepos/core";
import { REPO_URL } from "@docmyrepos/core/internal/site";

/** Test ids of the core's footer links, which the e2e suite finds them by. */
const TEST_IDS: Readonly<Record<string, string>> = { "/status": "footer-status-link" };

/** The footer links without a request context: the sync status. */
const STATUS_LINKS: readonly LinkItem[] = [{ href: "/status", label: "Sync status" }];

/** `links` is the `footer.links` slot: the sync status, then the plugins' links. */
export function SiteFooter({ links = STATUS_LINKS }: { links?: readonly LinkItem[] }) {
  return (
    <footer data-read-hide className="border-t border-border">
      <div className="site-shell mx-auto flex w-full max-w-[88rem] flex-wrap justify-between gap-2 px-5 py-8 text-sm text-muted-foreground sm:px-8 lg:px-16">
        <span className="inline-flex flex-wrap items-center gap-x-2">
          Powered by
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="footer-credit-link"
            className="inline-flex items-center hover:opacity-80"
          >
            {/* The dark logo is for light surfaces, the white one for the dark theme. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-black.png"
              alt="DocMyRepos"
              width={480}
              height={135}
              className="h-6 w-auto dark:hidden"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-white.png"
              alt="DocMyRepos"
              width={480}
              height={137}
              className="hidden h-6 w-auto dark:block"
            />
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
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            prefetch={false}
            data-testid={TEST_IDS[link.href]}
            className="text-muted-foreground hover:text-foreground"
          >
            {link.label}
          </Link>
        ))}
      </div>
    </footer>
  );
}
