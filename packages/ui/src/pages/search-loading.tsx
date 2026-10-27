/** Shown while the search results reads from Postgres (the page is rendered per request). */
export function SearchLoading() {
  return (
    <p role="status" className="text-muted-foreground">
      SearchLoading results…
    </p>
  );
}
