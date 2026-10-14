import Link from "next/link";

import { LogoutButton } from "./logout-button";
import { PaletteTrigger } from "./palette-trigger";
import { ThemeToggle } from "./theme-toggle";

export interface HeaderUser {
  readonly email: string;
  readonly role: "admin" | "user";
}

export function SiteHeader({ user }: { user: HeaderUser | null }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background">
      <div className="mx-auto flex min-h-16 w-full max-w-[88rem] flex-wrap items-center gap-x-8 px-5 sm:px-8 lg:px-16">
        <Link
          href="/"
          className="shrink-0 text-lg font-bold tracking-tight text-foreground no-underline hover:text-foreground"
        >
          DocMyRepos
        </Link>
        <nav
          aria-label="Main"
          className="order-last flex w-full items-center gap-6 pb-3 text-sm sm:order-none sm:w-auto sm:pb-0"
        >
          <Link href="/" className="text-muted-foreground no-underline hover:text-foreground">
            Repositories
          </Link>
          {user?.role === "admin" ? (
            <Link
              href="/admin"
              className="text-muted-foreground no-underline hover:text-foreground"
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
              <span className="hidden text-sm text-muted-foreground xl:inline" title="Signed in">
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
