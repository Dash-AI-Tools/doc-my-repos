/** Shown while the search results reads from Postgres (the page is rendered per request). */
export default function Loading() {
  return (
    <p role="status" className="text-muted-foreground">
      Loading results…
    </p>
  );
}
