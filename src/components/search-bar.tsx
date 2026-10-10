import { joinClassNames } from "@/lib/utils";

/**
 * The portal's search bar (task 9.2): a plain GET form to `/search?q=...`, so it works without
 * JavaScript and a result page is a shareable URL (search spec "Shareable URL"). The `/search`
 * page itself is task 10.3; the command palette (10.4) enhances this form, it does not replace it.
 *
 * Presentational: no state, no data access. `id` must be unique on the page (the label points at
 * it); pass another one if a second bar is ever rendered. The search landmark is named so a
 * second search form (header bar, 10.4) can be told apart.
 */
export const SEARCH_ACTION = "/search";
export const SEARCH_PARAM = "q";

export interface SearchBarProps {
  /** Prefilled query (the search page shows the current one). */
  readonly defaultValue?: string;
  readonly id?: string;
  readonly className?: string;
}

export function SearchBar({ defaultValue = "", id = "portal-search", className }: SearchBarProps) {
  return (
    <form
      action={SEARCH_ACTION}
      method="get"
      role="search"
      aria-label="Search documentation"
      className={joinClassNames("flex w-full gap-2", className)}
    >
      <label htmlFor={id} className="sr-only">
        Search all documentation
      </label>
      <input
        id={id}
        type="search"
        name={SEARCH_PARAM}
        defaultValue={defaultValue}
        placeholder="Search all documentation"
        autoComplete="off"
        maxLength={500}
        className="h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-base text-foreground"
      />
      <button
        type="submit"
        className="h-11 shrink-0 rounded-md bg-primary px-5 text-base font-medium text-primary-foreground hover:opacity-90"
      >
        Search
      </button>
    </form>
  );
}
