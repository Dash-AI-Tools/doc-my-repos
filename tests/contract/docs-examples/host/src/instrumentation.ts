export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { app } = await import("./docmyrepos");
  await app.start();
}
