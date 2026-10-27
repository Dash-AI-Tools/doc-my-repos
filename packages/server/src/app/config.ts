import { redactWhenLogged } from "../db/client";
import { parseEnv, retiredSources, type EnvConfig, type EnvSource } from "../config/env";
import { encryptionKeyFrom, type EncryptionKey } from "../settings/crypto";
import { schedulerMode, type SchedulerMode } from "../sync/schedule-runtime";

/**
 * The startup configuration: the values a server needs before it can read its database, from the
 * environment variables of the open-source app (`.env.example`) or from a host app's own object
 * with the same keys. Validation and problem texts are those of `parseEnv`; values never appear in
 * a problem. Workspace settings are not here: they live in each tenant's database.
 */
export interface StartupConfig {
  /** The values the configuration was read from. Held for code that reads them by name. */
  readonly source: EnvSource;
  /** The validated values, or null when a required one is missing or invalid. */
  readonly env: EnvConfig | null;
  /** One line per problem, naming the variable. */
  readonly problems: readonly string[];
  readonly encryptionKey:
    | { readonly key: EncryptionKey; readonly problem: null }
    | { readonly key: null; readonly problem: string };
  /** Retired settings still present (names only); they are ignored. */
  readonly retired: readonly string[];
  /** Whether the background scheduler runs in this process. */
  readonly scheduler: SchedulerMode;
}

/**
 * Reads and validates the startup configuration from `source` (default: `process.env`). Never
 * throws: a problem is reported, and the server keeps serving what it can.
 */
export function loadConfig(source: EnvSource = process.env): StartupConfig {
  const parsed = parseEnv(source);
  return Object.freeze(
    redactWhenLogged({
      source,
      env: parsed.env,
      problems: Object.freeze([...parsed.problems]),
      encryptionKey: encryptionKeyFrom(source),
      retired: Object.freeze(retiredSources(source)),
      scheduler: schedulerMode(source),
    }),
  );
}
