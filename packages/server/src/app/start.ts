import { DEFAULT_TENANT, type PluginSchedule, type TenantContext } from "@docmyrepos/core";

import { errorFields, logger as processLogger, type Logger } from "../log";
import { bootSyncScheduler, type SubmitJob } from "../sync/schedule-runtime";
import { getWorkspace, type Workspace } from "../workspace";
import type { StartupConfig } from "./config";
import type { RuntimeRegistry } from "./registry";
import type { EncryptionKeyResult, SecretsAdapter } from "./types";

export interface StartDeps {
  readonly log?: Logger;
  /** The secrets adapter. Default: the startup configuration's key. */
  readonly secrets?: SecretsAdapter;
  /** The tenants the scheduler runs for. Default: the built-in tenant. */
  readonly listTenants?: () => readonly TenantContext[] | Promise<readonly TenantContext[]>;
  /** A tenant's workspace. Default: the built-in tenant's, with the secrets adapter's key. */
  readonly workspaceOf?: (tenant: TenantContext) => Promise<Workspace>;
  /** The jobs adapter's `submit`, where the scheduled work goes. */
  readonly submit?: SubmitJob;
  /** The plugins' schedules. */
  readonly schedules?: readonly PluginSchedule[];
  /** Default: the real scheduler boot. */
  readonly bootScheduler?: typeof bootSyncScheduler;
}

/**
 * What a server does once when it starts, before it serves requests (the instrumentation hook
 * calls it through `app.start()`): it reports configuration problems and retired settings still
 * present (once, names only), then starts the background sync scheduler where it is enabled
 * (`SYNC_SCHEDULER`, `NODE_ENV`; see `sync/schedule-runtime.ts`). It never throws: a problem is
 * logged and the server keeps serving. Only the first call in a process does anything.
 */
/** Without a jobs adapter (tests), scheduled work is left undone. */
const notSubmitted: SubmitJob = async () => ({});

export async function startApp(
  config: StartupConfig,
  runtime: RuntimeRegistry,
  deps: StartDeps = {},
): Promise<void> {
  if (runtime.started) return;
  runtime.started = true;
  const log = deps.log ?? processLogger;
  if (config.env === null) log.error("config.env_invalid", { problems: config.problems });
  // The built-in tenant's key, the one the scheduler's workspace reads with.
  const keyOf = async (): Promise<EncryptionKeyResult> =>
    deps.secrets ? deps.secrets.encryptionKey(DEFAULT_TENANT) : config.encryptionKey;
  try {
    const key = await keyOf();
    if (key.key === null) log.error("config.encryption_key_invalid", { problem: key.problem });
  } catch (error) {
    log.error("adapter.failed", { adapter: "secrets", errorName: errorFields(error).errorName });
  }
  if (config.retired.length > 0) {
    // These values are no longer read; an administrator enters them in the admin settings.
    log.warn("config.retired_variables_ignored", { variables: config.retired });
  }
  await (deps.bootScheduler ?? bootSyncScheduler)({
    listTenants: deps.listTenants,
    getRuntime: deps.workspaceOf ?? (async () => getWorkspace({ encryptionKey: await keyOf() })),
    submit: deps.submit ?? notSubmitted,
    schedules: deps.schedules,
    env: config.source,
  });
}
