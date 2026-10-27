/**
 * Next.js instrumentation hook: `register()` runs once when a server instance starts, before it
 * serves requests. In the Node.js runtime it starts the app (`app.start()`: configuration checks,
 * then the background sync scheduler). The import is dynamic so the Edge runtime (the proxy) never
 * loads database or GitHub code.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { app } = await import("./docmyrepos");
  await app.start();
}
