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
    <header className="border-b border-border">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center px-4">
        <Link
          href="/"
          className="text-lg font-semibold tracking-tight text-foreground hover:text-foreground"
        >
          DocMyRepos
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <PaletteTrigger />
          <ThemeToggle />
          {user ? (
            <>
              {user.role === "admin" ? (
                <Link
                  href="/admin"
                  className="rounded-md border px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
                >
                  Admin
                </Link>
              ) : null}
              <span className="hidden text-sm text-muted-foreground sm:inline" title="Signed in">
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
