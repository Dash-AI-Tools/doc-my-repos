import { z } from "zod";

import { authErrorResponse, requireAdmin, type CurrentUser } from "../auth/current-user";
import {
  AI_PROVIDERS,
  providerAvailability,
  providerCredentials,
  type AiProvider,
  type AllProviderAvailability,
  type EnvSource,
} from "../config/env";
import { getDb, type Db } from "../db/client";
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
import { requireSameOrigin } from "../same-origin";

/**
 * Admin API for Ask (ask-the-docs design decision 9): `GET /api/admin/ask`, `PUT /api/admin/ask` and
 * `POST /api/admin/ask/test`. Every handler requires an admin session first; the writes also require
 * a same-origin JSON request. Responses never carry a key or an endpoint beyond its host name, and
 * the connection test returns one of five fixed words.
 */

export interface AskAdminDeps {
  readonly db?: Db;
  readonly env?: EnvSource;
  readonly log?: Logger;
  /** Resolves the admin (default `requireAdmin`, which throws 401/403). Tests only. */
  readonly admin?: (db: Db) => Promise<CurrentUser>;
  readonly providerDeps?: ProviderDeps;
  readonly testDeadlineMs?: number;
  readonly testLimiter?: AttemptWindow;
}

/** What the admin page shows. */
export interface AskAdminView {
  readonly settings: AskSettings;
  readonly providers: AllProviderAvailability;
  readonly state: AskState;
}

const MAX_BODY_CHARS = 4096;

function fieldError(field: string, message: string): Response {
  return Response.json(
    { error: message, field },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

function noStore(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

async function adminOrDenied(
  deps: AskAdminDeps,
  db: Db,
): Promise<{ admin: CurrentUser } | { denied: Response }> {
  try {
    return { admin: await (deps.admin ?? requireAdmin)(db) };
  } catch (error) {
    return { denied: authErrorResponse(error) };
  }
}

async function readJsonBody(request: Request): Promise<{ value: unknown } | { denied: Response }> {
  const origin = requireSameOrigin(request);
  if (!origin.ok) return { denied: noStore({ error: origin.error }, 403) };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { denied: noStore({ error: "The request body must be valid JSON" }, 400) };
  }
  if (text.length > MAX_BODY_CHARS) return { denied: noStore({ error: "Request too large" }, 413) };
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { denied: noStore({ error: "The request body must be valid JSON" }, 400) };
  }
}

function view(settings: AskSettings, env: EnvSource): AskAdminView {
  const providers = providerAvailability(env);
  return { settings, providers, state: resolveAsk(settings, providers) };
}

/** The admin view (settings, per-provider availability, current state) for the page and the API. */
export async function getAskAdminView(
  deps: AskAdminDeps = {},
  db: Db = deps.db ?? getDb().db,
): Promise<AskAdminView> {
  return view(await readAskSettings(db), deps.env ?? process.env);
}

/** The view for the admin page (a server component). Throws 401/403 errors on denial. */
export async function getAdminAskView(deps: AskAdminDeps = {}): Promise<AskAdminView> {
  const db = deps.db ?? getDb().db;
  await (deps.admin ?? requireAdmin)(db);
  return getAskAdminView(deps, db);
}

/** `GET /api/admin/ask`. */
export async function handleGetAsk(deps: AskAdminDeps = {}): Promise<Response> {
  try {
    const db = deps.db ?? getDb().db;
    const who = await adminOrDenied(deps, db);
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
export async function handleSaveAsk(request: Request, deps: AskAdminDeps = {}): Promise<Response> {
  const log = deps.log ?? logger;
  try {
    const db = deps.db ?? getDb().db;
    const who = await adminOrDenied(deps, db);
    if ("denied" in who) return who.denied;
    const body = await readJsonBody(request);
    if ("denied" in body) return body.denied;

    const parsed = SaveBody.safeParse(body.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const first = issue?.code === "unrecognized_keys" ? issue.keys[0] : issue?.path[0];
      return fieldError(typeof first === "string" ? first : "body", "The request is not valid");
    }
    const { enabled } = parsed.data;
    const current = await readAskSettings(db);
    const env = deps.env ?? process.env;

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
      const availability = providerAvailability(env);
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
    return noStore(view(saved, env));
  } catch (error) {
    log.error("ask.admin.failed", { action: "save", ...errorFields(error) });
    return noStore({ error: "Internal error" }, 500);
  }
}

const TestBody = z.strictObject({ provider: z.string(), model: z.string() });

/** `POST /api/admin/ask/test`: `{ provider, model }` -> `{ result }`. Never changes the saved choice. */
export async function handleTestAsk(request: Request, deps: AskAdminDeps = {}): Promise<Response> {
  const log = deps.log ?? logger;
  try {
    const db = deps.db ?? getDb().db;
    const who = await adminOrDenied(deps, db);
    if ("denied" in who) return who.denied;
    const body = await readJsonBody(request);
    if ("denied" in body) return body.denied;

    const parsed = TestBody.safeParse(body.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const first = issue?.code === "unrecognized_keys" ? issue.keys[0] : issue?.path[0];
      return fieldError(typeof first === "string" ? first : "body", "The request is not valid");
    }
    const choice = checkChoice(parsed.data.provider, parsed.data.model);
    if (choice instanceof Response) return choice;

    const env = deps.env ?? process.env;
    const credentials = providerCredentials(env, choice.provider);
    if (credentials === null) return notConfigured(providerAvailability(env), choice.provider);

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
