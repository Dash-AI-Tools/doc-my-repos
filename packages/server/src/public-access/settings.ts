import { eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { publicAccessSettings } from "../db/schema";

/**
 * Public access settings (public-access design decision 4): one row (`id` fixed to 1), edited by
 * an admin. No row means the defaults. Kept out of the workspace settings document because that
 * schema is strict: an image from before this feature would reject an unknown key there.
 */

export interface PublicAccessSettings {
  /** Anonymous visitors may search (once something is public). */
  readonly searchEnabled: boolean;
  /** Anonymous visitors may use Ask (also needs Ask itself on, with a provider). */
  readonly askEnabled: boolean;
  /** Questions per day, shared by all anonymous visitors. */
  readonly askQuestionsPerDay: number;
  /** Questions per ten minutes, shared by all anonymous visitors. */
  readonly askQuestionsPerTenMinutes: number;
}

export const DEFAULT_PUBLIC_ACCESS: PublicAccessSettings = Object.freeze({
  searchEnabled: true,
  askEnabled: false,
  askQuestionsPerDay: 200,
  askQuestionsPerTenMinutes: 20,
});

export const PUBLIC_ASK_PER_DAY_RANGE = { min: 1, max: 10_000 } as const;
export const PUBLIC_ASK_PER_TEN_MINUTES_RANGE = { min: 1, max: 1_000 } as const;

export type PublicAccessField = keyof PublicAccessSettings;

export type PublicAccessCheck =
  | { readonly ok: true; readonly value: Partial<PublicAccessSettings> }
  | { readonly ok: false; readonly field: PublicAccessField; readonly error: string };

function integerIn(
  value: unknown,
  range: { readonly min: number; readonly max: number },
): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= range.min && value <= range.max
  );
}

const FIELDS: readonly PublicAccessField[] = [
  "searchEnabled",
  "askEnabled",
  "askQuestionsPerDay",
  "askQuestionsPerTenMinutes",
];

/**
 * Validates an admin's change: any subset of the four fields, nothing else. The error names the
 * field and the allowed range, never the submitted value.
 */
export function checkPublicAccessChange(input: unknown): PublicAccessCheck {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, field: "searchEnabled", error: "Send an object of settings" };
  }
  const value: { -readonly [K in PublicAccessField]?: PublicAccessSettings[K] } = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!(FIELDS as readonly string[]).includes(key)) {
      return { ok: false, field: "searchEnabled", error: `The field "${key}" is not valid` };
    }
    switch (key as PublicAccessField) {
      case "searchEnabled":
      case "askEnabled":
        if (typeof raw !== "boolean") {
          return {
            ok: false,
            field: key as PublicAccessField,
            error: `${key} must be true or false`,
          };
        }
        value[key as "searchEnabled" | "askEnabled"] = raw;
        break;
      case "askQuestionsPerDay":
        if (!integerIn(raw, PUBLIC_ASK_PER_DAY_RANGE)) {
          return {
            ok: false,
            field: "askQuestionsPerDay",
            error: `askQuestionsPerDay must be a whole number from ${PUBLIC_ASK_PER_DAY_RANGE.min} to ${PUBLIC_ASK_PER_DAY_RANGE.max}`,
          };
        }
        value.askQuestionsPerDay = raw;
        break;
      case "askQuestionsPerTenMinutes":
        if (!integerIn(raw, PUBLIC_ASK_PER_TEN_MINUTES_RANGE)) {
          return {
            ok: false,
            field: "askQuestionsPerTenMinutes",
            error: `askQuestionsPerTenMinutes must be a whole number from ${PUBLIC_ASK_PER_TEN_MINUTES_RANGE.min} to ${PUBLIC_ASK_PER_TEN_MINUTES_RANGE.max}`,
          };
        }
        value.askQuestionsPerTenMinutes = raw;
        break;
    }
  }
  return { ok: true, value };
}

/** The stored settings, or the defaults when nobody has saved any. */
export async function readPublicAccessSettings(db: Db): Promise<PublicAccessSettings> {
  const [row] = await db.select().from(publicAccessSettings).where(eq(publicAccessSettings.id, 1));
  if (!row) return DEFAULT_PUBLIC_ACCESS;
  return {
    searchEnabled: row.searchEnabled,
    askEnabled: row.askEnabled,
    askQuestionsPerDay: row.askQuestionsPerDay,
    askQuestionsPerTenMinutes: row.askQuestionsPerTenMinutes,
  };
}

/** Saves a validated change (one upsert on the single row) and returns the result. */
export async function savePublicAccessSettings(
  db: Db,
  change: Partial<PublicAccessSettings>,
  adminId: number | null,
): Promise<PublicAccessSettings> {
  const set = { ...change, updatedAt: new Date(), updatedBy: adminId };
  await db
    .insert(publicAccessSettings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: publicAccessSettings.id, set });
  return readPublicAccessSettings(db);
}
