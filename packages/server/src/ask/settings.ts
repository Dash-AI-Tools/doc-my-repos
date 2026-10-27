import { eq } from "drizzle-orm";
import { cache } from "react";

import { isAiProvider, validateModel } from "@docmyrepos/core/internal/ask/providers";
import type { AiProvider } from "@docmyrepos/core/internal/ask/providers";
import {
  providerAvailability,
  type AllProviderAvailability,
  type ProviderSettingsInput,
} from "./credentials";
import { type Db } from "../db/client";
import { askSettings } from "../db/schema";
import { errorFields, logger } from "../log";
import { getWorkspace } from "../workspace";

/**
 * Ask settings (ask-the-docs design decision 9): the admin's on/off switch, provider and model, in
 * one database row. Credentials never live here; they are stored encrypted with the workspace secrets. The pure rules
 * (`validateModel`, `isAiProvider`, `resolveAsk`) are the only way any consumer decides whether Ask
 * runs, so the route, the `/ask` page, the header link and the status page cannot disagree.
 */

export {
  isAiProvider,
  validateModel,
  MODEL_MAX_LENGTH,
  type ModelCheck,
} from "@docmyrepos/core/internal/ask/providers";

/** The stored choice after re-validation: an unknown provider or invalid model reads as unset. */
export interface AskSettings {
  readonly enabled: boolean;
  readonly provider: AiProvider | null;
  readonly model: string | null;
}

export const UNSET_ASK_SETTINGS: AskSettings = { enabled: false, provider: null, model: null };

export type AskState =
  | { readonly state: "off" }
  | { readonly state: "ready"; readonly provider: AiProvider; readonly model: string }
  | {
      readonly state: "unavailable";
      /** Names of settings still to be entered, never values. */
      readonly missing: readonly string[];
      /** A fixed text naming the setting whose value was refused, never the value. */
      readonly problem?: string;
    };

/**
 * Whether Ask runs right now. `off` unless an admin turned it on. `unavailable` when it is on but
 * the choice is incomplete or the provider's settings are not usable. `ready` carries the
 * provider and model to use; callers resolve once per request and keep the result.
 */
export function resolveAsk(settings: AskSettings, availability: AllProviderAvailability): AskState {
  if (!settings.enabled) return { state: "off" };
  if (settings.provider === null || settings.model === null) {
    return { state: "unavailable", missing: [] };
  }
  const group = availability[settings.provider];
  if (!group.configured) {
    return {
      state: "unavailable",
      missing: group.missing,
      ...(group.problem === undefined ? {} : { problem: group.problem }),
    };
  }
  return { state: "ready", provider: settings.provider, model: settings.model };
}

async function readSettings(db: Db): Promise<AskSettings> {
  const [row] = await db.select().from(askSettings).where(eq(askSettings.id, 1));
  if (!row) return UNSET_ASK_SETTINGS;
  const model = row.model === null ? null : validateModel(row.model);
  return {
    enabled: row.enabled,
    provider: isAiProvider(row.provider) ? row.provider : null,
    model: model?.ok ? model.value : null,
  };
}

/** Ask settings for this request (cached). */
export const getAskSettings = cache(async (db: Db): Promise<AskSettings> => {
  return readSettings(db);
});

/** Uncached read for handlers: fresh after a write in the same request. */
export async function readAskSettings(db: Db): Promise<AskSettings> {
  return readSettings(db);
}

export interface AskSettingsChange {
  readonly enabled: boolean;
  /** Omitted keeps the stored value (turning off keeps the saved provider and model). */
  readonly provider?: AiProvider;
  readonly model?: string;
}

/** Saves the choice (one upsert on the single row). Inputs must already be validated. */
export async function saveAskSettings(
  db: Db,
  change: AskSettingsChange,
  adminId: number | null,
): Promise<AskSettings> {
  const set = {
    enabled: change.enabled,
    ...(change.provider === undefined ? {} : { provider: change.provider }),
    ...(change.model === undefined ? {} : { model: change.model }),
    updatedAt: new Date(),
    updatedBy: adminId,
  };
  await db
    .insert(askSettings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: askSettings.id, set });
  return readSettings(db);
}

/**
 * Where Ask stands for this request: stored choice plus the provider settings an administrator
 * saved. Never throws: if the settings cannot be read, Ask is treated as off so the rest of the
 * portal keeps working.
 */
export const getAskState = cache(
  async (db: Db, providers?: ProviderSettingsInput): Promise<AskState> => {
    try {
      const [settings, saved] = await Promise.all([
        getAskSettings(db),
        providers ? Promise.resolve(providers) : getWorkspace().then((w) => w.providers),
      ]);
      return resolveAsk(settings, providerAvailability(saved));
    } catch (error) {
      logger.warn("ask.settings.read_failed", errorFields(error));
      return { state: "off" };
    }
  },
);

/**
 * Ask's state for a request context: its tenant's settings and provider keys, and off when the
 * tenant is not entitled to Ask (`checkEntitlement`), exactly as when an administrator turned it
 * off. Like `getAskState`, it never throws: any failure reads as off.
 */
export async function askStateFor(ctx: {
  db(): Promise<Db>;
  workspace(): Promise<{ providers: ProviderSettingsInput }>;
  entitled(feature: "ask"): Promise<boolean>;
}): Promise<AskState> {
  try {
    const [db, workspace] = await Promise.all([ctx.db(), ctx.workspace()]);
    const state = await getAskState(db, workspace.providers);
    if (state.state === "off") return state;
    return (await ctx.entitled("ask")) ? state : { state: "off" };
  } catch {
    return { state: "off" };
  }
}
