import { z } from "zod";

import { requireAdmin, type CurrentUser } from "../auth/current-user";
import { AI_PROVIDERS, type AiProvider } from "@docmyrepos/core/internal/ask/providers";
import {
  providerAvailability,
  providerCredentials,
  type AllProviderAvailability,
  type ProviderSettingsInput,
} from "../ask/credentials";
import { type Db, type DbInput, resolveDb } from "../db/client";
import { errorFields, logger, type Logger } from "../log";
import { AttemptWindow, testAttempts, testConnection } from "../ask/connection-test";
import type { ProviderDeps } from "../ask/providers";
import {
  isAiProvider,
  readAskSettings,
  resolveAsk,
  saveAskSettings,
  validateModel,
  type AskSettings,
  type AskState,
} from "../ask/settings";
import { adminOrDenied, fieldError, noStore, readJsonBody } from "./http";
import { readSecretStatuses, readSettings as readWorkspaceSettings } from "../settings/store";
import { getWorkspace, type Workspace } from "../workspace";

/**
 * Admin API for Ask (ask-the-docs design decision 9): `GET /api/admin/ask`, `PUT /api/admin/ask` and
 * `POST /api/admin/ask/test`. Every handler requires an admin session first; the writes also require
 * a same-origin JSON request. Responses never carry a key or an endpoint beyond its host name, and
 * the connection test returns one of five fixed words.
 */

export interface AskAdminDeps {
  readonly db: DbInput;
  /** The provider settings. Default: the current workspace's. */
  readonly providers?: () => Promise<ProviderSettingsInput>;
  /** The tenant's workspace, re-checked when `fresh`. Default: the built-in tenant's. */
  readonly workspace?: (fresh: boolean) => Promise<Workspace>;
  readonly log?: Logger;
  /** Resolves the admin (default `requireAdmin`, which throws 401/403). Tests only. */
  readonly admin?: (db: Db) => Promise<CurrentUser>;
  readonly providerDeps?: ProviderDeps;
  readonly testDeadlineMs?: number;
  readonly testLimiter?: AttemptWindow;
}

/** Whether a provider key is stored and when it changed. Never the key. */
export interface KeyStatus {
  readonly set: boolean;
  readonly updatedAt: Date | null;
}

/** The provider credentials the page edits: what is stored, never a key. */
export interface AskCredentialsView {
  /** The settings version the credentials form was loaded from (sent back when saving). */
  readonly version: number;
  /** The OpenAI-compatible endpoint, or null. An address, not a secret. */
  readonly openaiBaseUrl: string | null;
  readonly anthropicKey: KeyStatus;
  readonly openaiKey: KeyStatus;
}

/** What the admin page shows. */
export interface AskAdminView {
  readonly settings: AskSettings;
  readonly providers: AllProviderAvailability;
  readonly state: AskState;
  readonly credentials: AskCredentialsView;
}

const MAX_BODY_CHARS = 4096;

async function providerSettings(deps: AskAdminDeps): Promise<ProviderSettingsInput> {
  if (deps.providers) return deps.providers();
  return (await (deps.workspace ? deps.workspace(true) : getWorkspace({ fresh: true }))).providers;
}

async function view(
  db: Db,
  settings: AskSettings,
  input: ProviderSettingsInput,
): Promise<AskAdminView> {
  const providers = providerAvailability(input);
  const [stored, statuses] = await Promise.all([readWorkspaceSettings(db), readSecretStatuses(db)]);
  return {
    settings,
    providers,
    state: resolveAsk(settings, providers),
    credentials: {
      version: stored.version,
      openaiBaseUrl: stored.settings.providers.openaiBaseUrl ?? null,
      anthropicKey: statuses.anthropic_api_key,
      openaiKey: statuses.openai_api_key,
    },
  };
}

/** The admin view (settings, per-provider availability, current state) for the page and the API. */
export async function getAskAdminView(
  deps: AskAdminDeps,
  source: DbInput = deps.db,
): Promise<AskAdminView> {
  const db = await resolveDb(source);
  return view(db, await readAskSettings(db), await providerSettings(deps));
}

/** The view for the admin page (a server component). Throws 401/403 errors on denial. */
export async function getAdminAskView(deps: AskAdminDeps): Promise<AskAdminView> {
  const db = await resolveDb(deps.db);
  await (deps.admin ?? requireAdmin)(db);
  return getAskAdminView(deps, db);
}

/** `GET /api/admin/ask`. */
export async function handleGetAsk(deps: AskAdminDeps): Promise<Response> {
  try {
    const db = await resolveDb(deps.db);
    const who = await adminOrDenied(deps.admin, db);
    if ("denied" in who) return who.denied;
    return noStore(await getAskAdminView(deps, db));
  } catch (error) {
    (deps.log ?? logger).error("ask.admin.failed", { action: "get", ...errorFields(error) });
    return noStore({ error: "Internal error" }, 500);
  }
}

const SaveBody = z.strictObject({
  enabled: z.boolean(),
  provider: z.string().optional(),
  model: z.string().optional(),
});

/** A provider id and model, checked like a save. */
function checkChoice(
  providerRaw: unknown,
  modelRaw: unknown,
): { provider: AiProvider; model: string } | Response {
  if (!isAiProvider(providerRaw)) {
    return fieldError("provider", `The provider must be one of: ${AI_PROVIDERS.join(", ")}`);
  }
  const model = validateModel(modelRaw);
  if (!model.ok) return fieldError("model", `The model name ${model.reason}`);
  return { provider: providerRaw, model: model.value };
}

function notConfigured(availability: AllProviderAvailability, provider: AiProvider): Response {
  const group = availability[provider];
  const reason =
    group.problem ??
    (group.missing.length > 0
      ? `${group.missing.join(", ")} not set`
      : "its credentials are not usable");
  return fieldError("provider", `This provider is not configured: ${reason}`);
}

/** `PUT /api/admin/ask`: `{ enabled, provider?, model? }`. Turning off keeps the saved choice. */
export async function handleSaveAsk(request: Request, deps: AskAdminDeps): Promise<Response> {
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
      return fieldError(typeof first === "string" ? first : "body", "The request is not valid");
    }
    const { enabled } = parsed.data;
    const current = await readAskSettings(db);
    const providerInput = await providerSettings(deps);

    let provider: AiProvider | undefined;
    if (parsed.data.provider !== undefined) {
      if (!isAiProvider(parsed.data.provider)) {
        return fieldError("provider", `The provider must be one of: ${AI_PROVIDERS.join(", ")}`);
      }
      provider = parsed.data.provider;
    }
    let model: string | undefined;
    if (parsed.data.model !== undefined) {
      const checked = validateModel(parsed.data.model);
      if (!checked.ok) return fieldError("model", `The model name ${checked.reason}`);
      model = checked.value;
    }

    if (enabled) {
      const chosenProvider = provider ?? current.provider;
      const chosenModel = model ?? current.model;
      if (chosenProvider === null)
        return fieldError("provider", "Choose a provider before turning Ask on");
      if (chosenModel === null)
        return fieldError("model", "Enter a model name before turning Ask on");
      const availability = providerAvailability(providerInput);
      if (!availability[chosenProvider].configured)
        return notConfigured(availability, chosenProvider);
    }

    const saved = await saveAskSettings(
      db,
      { enabled, ...(provider ? { provider } : {}), ...(model ? { model } : {}) },
      who.admin.id > 0 ? who.admin.id : null,
    );
    log.info("ask.settings.changed", {
      adminId: who.admin.id,
      enabled: saved.enabled,
      provider: saved.provider,
      model: saved.model,
    });
    return noStore(await view(db, saved, providerInput));
  } catch (error) {
    log.error("ask.admin.failed", { action: "save", ...errorFields(error) });
    return noStore({ error: "Internal error" }, 500);
  }
}

const TestBody = z.strictObject({ provider: z.string(), model: z.string() });

/** `POST /api/admin/ask/test`: `{ provider, model }` -> `{ result }`. Never changes the saved choice. */
export async function handleTestAsk(request: Request, deps: AskAdminDeps): Promise<Response> {
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
      return fieldError(typeof first === "string" ? first : "body", "The request is not valid");
    }
    const choice = checkChoice(parsed.data.provider, parsed.data.model);
    if (choice instanceof Response) return choice;

    const providerInput = await providerSettings(deps);
    const credentials = providerCredentials(providerInput, choice.provider);
    if (credentials === null) {
      return notConfigured(providerAvailability(providerInput), choice.provider);
    }

    const allowed = (deps.testLimiter ?? testAttempts).attempt();
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

    const result = await testConnection(credentials, choice.model, {
      ...(deps.testDeadlineMs === undefined ? {} : { deadlineMs: deps.testDeadlineMs }),
      ...(deps.providerDeps ? { providerDeps: deps.providerDeps } : {}),
    });
    log.info("ask.settings.tested", {
      adminId: who.admin.id,
      provider: choice.provider,
      model: choice.model,
      result,
    });
    return noStore({ result });
  } catch (error) {
    log.error("ask.admin.failed", { action: "test", ...errorFields(error) });
    return noStore({ error: "Internal error" }, 500);
  }
}
