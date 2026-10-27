/**
 * Process state shared by every application object of this process. Next.js can evaluate the
 * module that creates the app more than once (the instrumentation, route and React server layers
 * are bundled apart), so state that must exist once per process lives here, on `globalThis`, the
 * way the database handle and the workspace cache always have.
 */
export interface RuntimeRegistry {
  /** Set by the first `app.start()`; later calls do nothing. */
  started: boolean;
}

const REGISTRY_KEY = Symbol.for("docmyrepos.runtime");
type Holder = { [REGISTRY_KEY]?: RuntimeRegistry };

export function runtimeRegistry(): RuntimeRegistry {
  const holder = globalThis as Holder;
  holder[REGISTRY_KEY] ??= { started: false };
  return holder[REGISTRY_KEY];
}

/** Test seam: forgets the process state. */
export function resetRuntimeRegistry(): void {
  delete (globalThis as Holder)[REGISTRY_KEY];
}
