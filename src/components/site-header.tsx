import Link from "next/link";

import { PaletteTrigger } from "./palette-trigger";
import { ThemeToggle } from "./theme-toggle";

export function SiteHeader() {
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
        </div>
      </div>
    </header>
  );
}
