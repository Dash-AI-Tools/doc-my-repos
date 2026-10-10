import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap justify-between gap-2 px-4 py-6 text-sm text-muted-foreground">
        <span>DocMyRepos, open-source documentation portal.</span>
        <Link href="/status" prefetch={false} data-testid="footer-status-link">
          Sync status
        </Link>
      </div>
    </footer>
  );
}
