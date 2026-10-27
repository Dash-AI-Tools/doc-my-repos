import { z } from "zod";

import type { DomainEventInput } from "@docmyrepos/core";

import { requireAdmin, type CurrentUser } from "../auth/current-user";
import { Secret } from "../config/secret";
import type { AppConfig } from "@docmyrepos/core/internal/config/schema";
import { type Db, type DbInput, resolveDb } from "../db/client";
import type { WorkspaceSecretName } from "../db/schema";
import { errorFields, logger, type Logger } from "../log";
import { AttemptWindow } from "../ask/connection-test";
import { encryptionKeyFrom, type EncryptionKey } from "../settings/crypto";
import { testGithub, type GithubTestOptions } from "../settings/github-test";
import { normalizeSecret, secretProblem } from "../settings/secret-validation";
import {
  logSettingsChange,
  logSettingsFailure,
  readSecrets,
  readSecretStatuses,
  readSettings,
  saveWorkspace,
  type SecretStatuses,
} from "../settings/store";
import {
  getWorkspace,
  invalidateWorkspace,
  type Workspace,
  type WorkspaceProblems,
} from "../workspace";
import { adminOrDenied, noStore, readJsonBody } from "./http";

/**
 * Admin API for the workspace settings (workspace-settings design decisions 3, 5, 7 and 9):
 * `GET` and `PUT /api/admin/settings`, `POST /api/admin/settings/test` (GitHub), and
 * `PUT /api/admin/ask/credentials` (provider keys, with the Ask page). Every handler requires an
 * admin session first; the writes also require a same-origin JSON request. Secrets are write-only:
 * no response, log or error carries a secret value, its length or a part of it.
 */

/** The built-in tenant's workspace (the open-source app's only one). */
function defaultWorkspace(fresh: boolean): Promise<Workspace> {
  return getWorkspace({ fresh });
}

export interface SettingsAdminDeps {
  readonly db: DbInput;
  readonly log?: Logger;
  /** Resolves the admin (default `requireAdmin`, which throws 401/403). Tests only. */
  readonly admin?: (db: Db) => Promise<CurrentUser>;
  /** The tenant's encryption key (the secrets adapter's). Default: from the environment. */
  readonly encryptionKey?: () => EncryptionKey | null | Promise<EncryptionKey | null>;
  /** What is missing or unreadable. Default: from the current workspace. */
  readonly problems?: () => Promise<WorkspaceProblems>;
  /** Receives the `settings.updated` event of a save. */
  readonly emit?: (event: DomainEventInput) => void;
  /** The tenant whose workspace a save invalidates. Default: the built-in tenant. */
  readonly tenantId?: string;
  /** The tenant's workspace, re-checked when `fresh`. Default: the built-in tenant's. */
  readonly workspace?: (fresh: boolean) => Promise<Workspace>;
  readonly githubTest?: GithubTestOptions;
  readonly testLimiter?: AttemptWindow;
}

/** The non-secret settings, as shown and edited on the admin pages. */
export type EditableSettings = AppConfig;

/** What the admin pages show: settings, whether each secret is set, and what is missing. */
export interface SettingsAdminView {
  readonly version: number;
  readonly settings: EditableSettings;
  readonly secrets: SecretStatuses;
  readonly problems: WorkspaceProblems;
}

const MAX_BODY_CHARS = 64 * 1024;
export const githubTestAttempts = new AttemptWindow();

async function encryptionKeyOf(deps: SettingsAdminDeps): Promise<EncryptionKey | null> {
  return deps.encryptionKey ? deps.encryptionKey() : encryptionKeyFrom(process.env).key;
}

/** The view for the pages and the API. Admin check is the caller's job. */
export async function getSettingsAdminView(
  deps: SettingsAdminDeps,
  source: DbInput = deps.db,
): Promise<SettingsAdminView> {
  const db = await resolveDb(source);
  const [snapshot, secrets, problems] = await Promise.all([
    readSettings(db),
    readSecretStatuses(db),
    deps.problems
      ? deps.problems()
      : (deps.workspace ?? defaultWorkspace)(true).then((w) => w.problems),
  ]);
  return {
    version: snapshot.version,
    settings: snapshot.settings,
    secrets,
    problems,
  };
}

/** The view for an admin page (a server component). Throws 401/403 errors on denial. */
export async function getAdminSettingsView(deps: SettingsAdminDeps): Promise<SettingsAdminView> {
  const db = await resolveDb(deps.db);
  await (deps.admin ?? requireAdmin)(db);
  return getSettingsAdminView(deps, db);
}

/** `GET /api/admin/settings`. */
export async function handleGetSettings(deps: SettingsAdminDeps): Promise<Response> {
  try {
    const db = await resolveDb(deps.db);
    const who = await adminOrDenied(deps.admin, db);
    if ("denied" in who) return who.denied;
    return noStore(await getSettingsAdminView(deps, db));
  } catch (error) {
    (deps.log ?? logger).error("settings.admin.failed", { action: "get", ...errorFields(error) });
    return noStore({ error: "Internal error" }, 500);
  }
}

const SECRET_NAMES = [
  "github_private_key",
  "github_webhook_secret",
  "anthropic_api_key",
  "openai_api_key",
] as const satisfies readonly WorkspaceSecretName[];

const SecretsBody = z.partialRecord(z.enum(SECRET_NAMES), z.string().max(8192).nullable());

const SaveBody = z.strictObject({
  expectedVersion: z.int().min(0),
  settings: z.unknown().optional(),
  secrets: SecretsBody.optional(),
});

/** An empty or whitespace-only secret field means "keep the stored value". */
function keepEmptySecrets(
  secrets: z.infer<typeof SecretsBody> | undefined,
): Partial<Record<WorkspaceSecretName, string | null>> {
  const out: Partial<Record<WorkspaceSecretName, string | null>> = {};
  for (const [name, value] of Object.entries(secrets ?? {}) as [
    WorkspaceSecretName,
    string | null,
  ][]) {
    if (value === null || value.trim() !== "") out[name] = value;
  }
  return out;
}

function saveFailure(result: Exclude<Awaited<ReturnType<typeof saveWorkspace>>, { ok: true }>) {
  if (result.reason === "conflict") {
    return noStore(
      {
        error: "The settings changed since you opened this page. Reload it and try again.",
        code: "conflict",
      },
      409,
    );
  }
  return noStore({ error: "The settings are not valid", problems: result.problems }, 400);
}

async function applySave(
  deps: SettingsAdminDeps,
  db: Db,
  admin: CurrentUser,
  change: {
    expectedVersion: number;
    settings?: unknown;
    secrets?: Partial<Record<WorkspaceSecretName, string | null>>;
  },
): Promise<Response> {
  const result = await saveWorkspace(db, await encryptionKeyOf(deps), {
    userId: admin.id > 0 ? admin.id : null,
    ...change,
  });
  if (!result.ok) {
    (deps.log ?? logger).info("settings.save_refused", {
      adminId: admin.id,
      reason: result.reason,
      ...(result.reason === "invalid" ? { fields: fieldsOf(result.problems) } : {}),
    });
    return saveFailure(result);
  }
  invalidateWorkspace(deps.tenantId);
  if (result.changed.length > 0) logSettingsChange(admin.id, result.changed);
  deps.emit?.({
    name: "settings.updated",
    payload: { version: result.version, sections: [...result.changed] },
    actorId: admin.id,
  });
  return noStore(await getSettingsAdminView(deps, db));
}

/** The field part of each "field: message" problem, so the log names fields and no values. */
function fieldsOf(problems: readonly string[]): string[] {
  return problems.map((p) => p.slice(0, Math.max(0, p.indexOf(":"))) || "body");
}

/**
 * `PUT /api/admin/settings`: `{ expectedVersion, settings?, secrets? }`. `settings` is the full new
 * settings object. In `secrets`, a string sets or replaces, `null` clears, an empty string or a
 * missing key keeps the stored value.
 */
export async function handleSaveSettings(
  request: Request,
  deps: SettingsAdminDeps,
): Promise<Response> {
  const log = deps.log ?? logger;
  try {
    const db = await resolveDb(deps.db);
    const who = await adminOrDenied(deps.admin, db);
    if ("denied" in who) return who.denied;
    const body = await readJsonBody(request, MAX_BODY_CHARS);
    if ("denied" in body) return body.denied;

    const parsed = SaveBody.safeParse(body.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const first = issue?.code === "unrecognized_keys" ? issue.keys[0] : issue?.path[0];
      return noStore(
        { error: "The request is not valid", field: typeof first === "string" ? first : "body" },
        400,
      );
    }
    return await applySave(deps, db, who.admin, {
      expectedVersion: parsed.data.expectedVersion,
      ...(parsed.data.settings === undefined ? {} : { settings: parsed.data.settings }),
      secrets: keepEmptySecrets(parsed.data.secrets),
    });
  } catch (error) {
    logSettingsFailure(error);
    log.error("settings.admin.failed", { action: "save", ...errorFields(error) });
    return noStore({ error: "Internal error" }, 500);
  }
}

const CredentialsBody = z.strictObject({
  expectedVersion: z.int().min(0),
  openaiBaseUrl: z.string().max(2048).nullable().optional(),
  secrets: z
    .partialRecord(z.enum(["anthropic_api_key", "openai_api_key"]), z.string().max(8192).nullable())
    .optional(),
});

/**
 * `PUT /api/admin/ask/credentials`: `{ expectedVersion, openaiBaseUrl?, secrets? }`. Changes only
 * the provider endpoint and keys; every other setting is kept as it is stored.
 */
export async function handleSaveProviderCredentials(
  request: Request,
  deps: SettingsAdminDeps,
): Promise<Response> {
  const log = deps.log ?? logger;
  try {
    const db = await resolveDb(deps.db);
    const who = await adminOrDenied(deps.admin, db);
    if ("denied" in who) return who.denied;
    const body = await readJsonBody(request, MAX_BODY_CHARS);
    if ("denied" in body) return body.denied;

    const parsed = CredentialsBody.safeParse(body.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const first = issue?.code === "unrecognized_keys" ? issue.keys[0] : issue?.path[0];
      return noStore(
        { error: "The request is not valid", field: typeof first === "string" ? first : "body" },
        400,
      );
    }
    const change: Parameters<typeof applySave>[3] = {
      expectedVersion: parsed.data.expectedVersion,
      secrets: keepEmptySecrets(parsed.data.secrets),
    };
    if (parsed.data.openaiBaseUrl !== undefined) {
      const current = await readSettings(db);
      const url = parsed.data.openaiBaseUrl?.trim() ?? "";
      const providers = { ...current.settings.providers };
      if (url === "") delete providers.openaiBaseUrl;
      else providers.openaiBaseUrl = url;
      change.settings = { ...current.settings, providers };
    }
    return await applySave(deps, db, who.admin, change);
  } catch (error) {
    logSettingsFailure(error);
    log.error("settings.admin.failed", { action: "save_credentials", ...errorFields(error) });
    return noStore({ error: "Internal error" }, 500);
  }
}

const TestBody = z.strictObject({
  appId: z.int().min(1).optional(),
  installationId: z.int().min(1).optional(),
  privateKey: z.string().max(8192).optional(),
});

/**
 * `POST /api/admin/settings/test`: tries the GitHub App with submitted values, falling back to the
 * stored ones for anything left out, and answers `{ result, repositories? }`. Never saves.
 */
export async function handleTestGithub(
  request: Request,
  deps: SettingsAdminDeps,
): Promise<Response> {
  const log = deps.log ?? logger;
  try {
    const db = await resolveDb(deps.db);
    const who = await adminOrDenied(deps.admin, db);
    if ("denied" in who) return who.denied;
    const body = await readJsonBody(request, MAX_BODY_CHARS);
    if ("denied" in body) return body.denied;

    const parsed = TestBody.safeParse(body.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const first = issue?.code === "unrecognized_keys" ? issue.keys[0] : issue?.path[0];
      return noStore(
        { error: "The request is not valid", field: typeof first === "string" ? first : "body" },
        400,
      );
    }

    const allowed = (deps.testLimiter ?? githubTestAttempts).attempt();
    if (!allowed.ok) {
      return noStore(
        {
          error: "Too many tests. Try again shortly.",
          retryAfterSeconds: allowed.retryAfterSeconds,
        },
        429,
        { "Retry-After": String(allowed.retryAfterSeconds) },
      );
    }

    const stored = await readSettings(db);
    const appId = parsed.data.appId ?? stored.settings.github.appId;
    const installationId = parsed.data.installationId ?? stored.settings.github.installationId;
    let privateKey: Secret<string> | null = null;
    if (parsed.data.privateKey !== undefined && parsed.data.privateKey.trim() !== "") {
      const problem = secretProblem("github_private_key", parsed.data.privateKey);
      if (problem !== null) return noStore({ error: problem, field: "privateKey" }, 400);
      privateKey = new Secret(normalizeSecret("github_private_key", parsed.data.privateKey));
    } else {
      privateKey = await storedPrivateKey(db, deps);
    }
    if (appId === undefined || installationId === undefined || privateKey === null) {
      return noStore({ error: "Enter the App id, installation id and private key first." }, 400);
    }

    const outcome = await testGithub({ appId, installationId, privateKey }, deps.githubTest);
    log.info("settings.github.tested", { adminId: who.admin.id, result: outcome.result });
    return noStore(outcome);
  } catch (error) {
    log.error("settings.admin.failed", { action: "test", ...errorFields(error) });
    return noStore({ error: "Internal error" }, 500);
  }
}

async function storedPrivateKey(db: Db, deps: SettingsAdminDeps): Promise<Secret<string> | null> {
  const key = await encryptionKeyOf(deps);
  if (key === null) return null;
  return (await readSecrets(db, key)).values.github_private_key ?? null;
}
