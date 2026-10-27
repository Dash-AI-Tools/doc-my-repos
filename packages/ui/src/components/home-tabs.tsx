import Link from "next/link";

export interface HomeTabLink {
  readonly id: number;
  readonly name: string;
}

/**
 * Home page tabs (repo-folders): All, then one per starred folder. Plain links to `/` and
 * `/?folder=<id>`, not client state, so a tab can be shared and works without JavaScript.
 * `aria-current="page"` marks the selected one. The bar scrolls inside its own container when
 * there are many, never the page.
 */
export function HomeTabs({
  tabs,
  selected,
}: {
  readonly tabs: readonly HomeTabLink[];
  /** The selected folder id, or null for All. */
  readonly selected: number | null;
}) {
  const items: { key: string; href: string; label: string; current: boolean }[] = [
    { key: "all", href: "/", label: "All", current: selected === null },
    ...tabs.map((t) => ({
      key: String(t.id),
      href: `/?folder=${t.id}`,
      label: t.name,
      current: t.id === selected,
    })),
  ];
  return (
    <nav aria-label="Folders" data-testid="home-tabs" className="-mb-8 overflow-x-auto">
      <ul role="list" className="flex w-max min-w-full gap-x-1 border-b border-border">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              aria-current={item.current ? "page" : undefined}
              className={`-mb-px block min-h-6 border-b-2 px-3 py-2 font-medium whitespace-nowrap ${
                item.current
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
