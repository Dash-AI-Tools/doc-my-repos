import Link from "next/link";
import type { CSSProperties } from "react";

import { AccountMenu } from "./account-menu";
import { HeaderHeight } from "./header-height";
import { PaletteTrigger } from "./palette-trigger";
import { TextSizeMenu } from "./text-size-menu";

export interface HeaderUser {
  readonly email: string;
  readonly role: "admin" | "user";
}

/** What the header shows of the portal brand (org-branding 3.3). */
export interface HeaderBranding {
  readonly orgName: string | null;
  readonly pageTitle: string | null;
  readonly logoVersion: number;
  readonly hasLogo: boolean;
  /** The bar is filled: scope the focus ring to the bar tokens. */
  readonly coloredBar: boolean;
}

export function SiteHeader({
  user,
  branding,
  askEnabled = false,
  agentAccess = false,
}: {
  user: HeaderUser | null;
  branding: HeaderBranding;
  /** Ask is on and usable (ask-the-docs): shows the Ask link in the main navigation. */
  askEnabled?: boolean;
  /** The MCP endpoint is on (mcp-agent-access): the account menu links to the agent pages. */
  agentAccess?: boolean;
}) {
  // With a logo the page title names the portal (the org name would repeat the logo). Without
  // one both are shown; with neither, the wordmark. See the org-branding spec.
  const text = branding.hasLogo
    ? branding.pageTitle
    : [branding.orgName, branding.pageTitle].filter((part) => part !== null).join(" · ") ||
      "DocMyRepos";
  // The title sits beside the logo, so the image needs no name of its own; alone it says "Home".
  const logoAlt = branding.hasLogo && branding.pageTitle !== null ? "" : "Home";
  return (
    <header
      data-read-hide
      className="sticky top-0 z-30 border-b border-header-border bg-header"
      style={
        branding.coloredBar ? ({ "--ring": "var(--header-ring)" } as CSSProperties) : undefined
      }
    >
      <HeaderHeight />
      <div className="site-shell mx-auto flex min-h-16 w-full max-w-[88rem] flex-wrap items-center gap-x-8 px-5 sm:px-8 lg:px-16">
        <Link
          href="/"
          className="flex min-w-0 max-w-full shrink items-center gap-2 text-lg font-bold tracking-tight text-header-foreground no-underline hover:text-header-foreground"
        >
          {branding.hasLogo ? (
            // Fixed-height box, so the measured header height never depends on the image. A plain
            // img: the URL is versioned and served by our own route, and the logo may be an SVG.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/branding/logo?v=${branding.logoVersion}`}
              alt={logoAlt}
              className="h-8 max-w-40 shrink-0 object-contain"
              style={{ filter: "var(--logo-filter, none)" }}
            />
          ) : null}
          <span className="min-w-0 break-words">{text}</span>
        </Link>
        <nav
          aria-label="Main"
          className="order-last flex w-full items-center gap-6 pb-3 text-sm sm:order-none sm:w-auto sm:pb-0"
        >
          <Link
            href="/"
            className="font-medium text-header-foreground no-underline hover:text-header-foreground hover:underline"
          >
            Repositories
          </Link>
          {askEnabled ? (
            <Link
              href="/ask"
              className="font-medium text-header-foreground no-underline hover:text-header-foreground hover:underline"
            >
              Ask
            </Link>
          ) : null}
        </nav>
        <div className="ml-auto flex min-h-16 max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-2 py-2 sm:gap-x-5">
          <TextSizeMenu />
          <PaletteTrigger />
          {user ? <AccountMenu user={user} agentAccess={agentAccess} /> : null}
        </div>
      </div>
    </header>
  );
}
