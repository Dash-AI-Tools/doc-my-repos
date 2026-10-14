import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-[88rem] flex-wrap justify-between gap-2 px-5 py-8 text-sm text-muted-foreground sm:px-8 lg:px-16">
        <span>DocMyRepos, open-source documentation portal.</span>
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
