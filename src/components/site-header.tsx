import Link from "next/link";
import type { CSSProperties } from "react";

import { HeaderHeight } from "./header-height";
import { LogoutButton } from "./logout-button";
import { PaletteTrigger } from "./palette-trigger";
import { ThemeToggle } from "./theme-toggle";

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
}: {
  user: HeaderUser | null;
  branding: HeaderBranding;
}) {
  const name = branding.orgName;
  const logoAlt = name !== null ? "" : (branding.pageTitle ?? "Home");
  return (
    <header
      className="sticky top-0 z-30 border-b border-header-border bg-header"
      style={
        branding.coloredBar ? ({ "--ring": "var(--header-ring)" } as CSSProperties) : undefined
      }
    >
      <HeaderHeight />
      <div className="site-shell mx-auto flex min-h-16 w-full max-w-[88rem] flex-wrap items-center gap-x-8 px-5 sm:px-8 lg:px-16">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 text-lg font-bold tracking-tight text-header-foreground no-underline hover:text-header-foreground"
        >
          {branding.hasLogo ? (
            // Fixed-height box, so the measured header height never depends on the image.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/branding/logo?v=${branding.logoVersion}`}
              alt={logoAlt}
              className="h-8 max-w-40 object-contain"
              style={{ filter: "var(--logo-filter, none)" }}
            />
          ) : null}
          {name ?? (branding.hasLogo ? null : "DocMyRepos")}
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
          {user?.role === "admin" ? (
            <Link
              href="/admin"
              className="font-medium text-header-foreground no-underline hover:text-header-foreground hover:underline"
            >
              Admin
            </Link>
          ) : null}
        </nav>
        <div className="ml-auto flex h-16 items-center gap-3 sm:gap-5">
          <PaletteTrigger />
          <ThemeToggle />
          {user ? (
            <>
              <span className="hidden text-sm text-header-foreground xl:inline" title="Signed in">
                {user.email}
              </span>
              <LogoutButton />
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
