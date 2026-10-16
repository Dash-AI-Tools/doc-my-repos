/**
 * Next.js instrumentation hook: `register()` runs once when a server instance starts, before it
 * serves requests. It checks the environment that remains after the settings moved to the database
 * (logging problems and any retired variables still present, once, names only), then starts the
 * background sync scheduler (startup sync, periodic full sync, drain of waiting sync requests) in
 * the Node.js runtime only; see `src/server/sync/schedule-runtime.ts` for when it is enabled
 * (`SYNC_SCHEDULER`, `NODE_ENV`) and what it runs. It never throws: a problem is logged once and
 * the server keeps serving.
 *
 * The imports are dynamic so the Edge runtime (the proxy) never loads database or GitHub code.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [
    { bootSyncScheduler },
    { getWorkspace },
    { parseEnv, retiredSources },
    { ENCRYPTION_KEY_VAR, parseEncryptionKey },
    { logger },
  ] = await Promise.all([
    import("./server/sync/schedule-runtime"),
    import("./server/workspace"),
    import("./server/config/env"),
    import("./server/settings/crypto"),
    import("./server/log"),
  ]);

  const parsed = parseEnv(process.env);
  if (parsed.env === null) logger.error("config.env_invalid", { problems: parsed.problems });
  const key = parseEncryptionKey(process.env[ENCRYPTION_KEY_VAR]);
  if (key.key === null) logger.error("config.encryption_key_invalid", { problem: key.problem });
  const retired = retiredSources(process.env);
  if (retired.length > 0) {
    // These values are no longer read; an administrator enters them in the admin settings.
    logger.warn("config.retired_variables_ignored", { variables: retired });
  }

  await bootSyncScheduler({ getRuntime: () => getWorkspace() });
}
