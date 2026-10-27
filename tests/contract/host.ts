import { createApp, type CreateAppOptions } from "@docmyrepos/server";

/**
 * The sample host app of the contract suite: an app composed only through the public API, the way
 * an external product builds one. Each test passes the hooks, adapters and plugins it exercises.
 */
export const HOST_CONFIG = {
  SESSION_SECRET: "contract-session-secret-0123456789",
  SYNC_SECRET: "contract-sync-secret-0123456789",
  SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
} as const;

export function createHostApp(databaseUrl: string, options: Omit<CreateAppOptions, "config"> = {}) {
  return createApp({ ...options, config: { ...HOST_CONFIG, DATABASE_URL: databaseUrl } });
}
