/**
 * Next.js instrumentation hook: `register()` runs once when a server instance starts, before it
 * serves requests. It starts the background sync scheduler (startup sync, periodic full sync,
 * drain of waiting sync requests) in the Node.js runtime only; see
 * `src/server/sync/schedule-runtime.ts` for when it is enabled (`SYNC_SCHEDULER`, `NODE_ENV`) and
 * what it runs. It never throws: a bad config is logged once and the server keeps serving.
 *
 * The imports are dynamic so the Edge runtime (the proxy) never loads database or GitHub code.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ bootSyncScheduler }, { getRuntime }] = await Promise.all([
    import("./server/sync/schedule-runtime"),
    import("./server/runtime"),
  ]);
  bootSyncScheduler({ getRuntime: () => getRuntime() });
}
