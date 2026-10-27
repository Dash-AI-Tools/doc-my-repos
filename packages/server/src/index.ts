// Public entrypoint of @docmyrepos/server. Everything exported here is covered by semver;
// `@docmyrepos/server/internal/*` is not.
export { loadConfig, type StartupConfig } from "./app/config";
export { CompositionError, createApp, type App, type CreateAppOptions } from "./app/create-app";
export {
  EmailNotConfiguredError,
  UnsupportedBlobError,
  createDefaultHooks,
  defaultAdapters,
} from "./app/defaults";
export {
  SessionUserUnavailableError,
  readCookie,
  sessionUser,
  type SessionUserDeps,
} from "./auth/authenticate";
export type {
  AdapterName,
  Adapters,
  BlobStore,
  DatabaseAdapter,
  EmailAdapter,
  EmailMessage,
  EncryptionKeyResult,
  HookName,
  Hooks,
  Job,
  JobRunOptions,
  JobsAdapter,
  Plugin,
  RequestContext,
  SecretsAdapter,
  StoredBlob,
} from "./app/types";
export { createDb, type Db, type DbHandle } from "./db/client";
export { parseEncryptionKey, type EncryptionKey } from "./settings/crypto";
export { InvalidJobPayloadError, UnknownJobError, UnknownJobTenantError } from "./jobs/runner";
