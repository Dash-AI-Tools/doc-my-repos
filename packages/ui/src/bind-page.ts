import type { App } from "@docmyrepos/server";

/** Props a page or layout of the UI package receives from its binding: the composed app. */
export interface AppProps {
  readonly app: App;
}

/**
 * Binds a page or layout of `@docmyrepos/ui/pages/*` to an app, for a route file's default export:
 *
 *   export default bindPage(HomePage, app);
 *
 * Next.js passes the route props (`params`, `searchParams`, `children`); the page gets them plus
 * `app`.
 */
export function bindPage<P extends object, R>(
  Page: (props: P) => R,
  app: App,
): (props: Omit<P, keyof AppProps>) => R {
  return function BoundPage(props) {
    return Page({ ...props, app } as unknown as P);
  };
}
