import { joinClassNames } from "@/lib/utils";

/**
 * The portal's search bar (task 9.2): a plain GET form to `/search?q=...`, so it works without
 * JavaScript and a result page is a shareable URL (search spec "Shareable URL"). The `/search`
 * page (task 10.3) shows it again with the current query; the command palette (10.4) enhances this
 * form, it does not replace it.
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
  /**
   * Extra fields sent with the query as hidden inputs. The search page passes the active filters
   * and the page size so that a new query keeps them (and, by design, drops `page`: the old page
   * number means nothing for different results). They follow the visible field in the markup, so
   * the URL the browser builds starts with `q`; it parses to the same state as the canonical URL
   * `buildSearchUrl` writes (order and `+` for a space differ).
   */
  readonly hiddenFields?: readonly { readonly name: string; readonly value: string }[];
  readonly id?: string;
  readonly className?: string;
}

export function SearchBar({
  defaultValue = "",
  hiddenFields = [],
  id = "portal-search",
  className,
}: SearchBarProps) {
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
        className="h-12 min-w-0 flex-1 rounded-none border-0 border-b border-input bg-transparent px-1 text-lg text-foreground focus-visible:border-foreground"
      />
      {hiddenFields.map((field) => (
        <input
          key={`${field.name}=${field.value}`}
          type="hidden"
          name={field.name}
          value={field.value}
        />
      ))}
      <button
        type="submit"
        className="h-12 shrink-0 bg-foreground px-6 text-base font-medium text-background hover:bg-primary hover:text-primary-foreground"
      >
        Search
      </button>
    </form>
  );
}
