import { eq, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import {
  settingsAudit,
  WORKSPACE_SECRET_NAMES,
  workspaceSecrets,
  workspaceSettings,
  type WorkspaceSecretName,
} from "../db/schema";
import { configSchema, formatConfigIssues, type AppConfig } from "../config/schema";
import { Secret } from "../config/secret";
import { errorFields, logger } from "../log";
import { decryptSecret, encryptSecret, type EncryptionKey } from "./crypto";
import { normalizeSecret, secretProblem } from "./secret-validation";

/**
 * The workspace settings store (workspace-settings design decisions 1, 3, 5 and 9). Plain settings
 * are one validated JSON row with a version; secrets are encrypted rows that can be set, replaced
 * or cleared but never read back as text by the admin interface. A save is optimistic (it names
 * the version it started from) and changes settings, secrets and the audit record in one
 * transaction. Nothing here logs or returns a secret value.
 */

export const SETTINGS_ROW_ID = 1;
/** Version of a workspace that has never been saved. */
export const UNSAVED_VERSION = 0;

export interface SettingsSnapshot {
  readonly settings: AppConfig;
  readonly version: number;
  /** False when the stored JSON no longer passes validation; defaults are used meanwhile. */
  readonly valid: boolean;
  readonly updatedAt: Date | null;
}

export interface SecretStatus {
  readonly set: boolean;
  readonly updatedAt: Date | null;
}

export type SecretStatuses = Readonly<Record<WorkspaceSecretName, SecretStatus>>;

const DEFAULT_SETTINGS = (): AppConfig => configSchema.parse({});

/** The stored settings with defaults applied. A workspace that was never saved has version 0. */
export async function readSettings(db: Db): Promise<SettingsSnapshot> {
  const [row] = await db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.id, SETTINGS_ROW_ID));
  if (!row) {
    return { settings: DEFAULT_SETTINGS(), version: UNSAVED_VERSION, valid: true, updatedAt: null };
  }
  const parsed = configSchema.safeParse(row.data, { reportInput: false });
  if (!parsed.success) {
    logger.error("settings.stored_invalid", { version: row.version });
    return {
      settings: DEFAULT_SETTINGS(),
      version: row.version,
      valid: false,
      updatedAt: row.updatedAt,
    };
  }
  return { settings: parsed.data, version: row.version, valid: true, updatedAt: row.updatedAt };
}

/** Only the version, for the cheap "has anything changed" check. */
export async function readVersion(db: Db): Promise<number> {
  const [row] = await db
    .select({ version: workspaceSettings.version })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.id, SETTINGS_ROW_ID));
  return row?.version ?? UNSAVED_VERSION;
}

/** Whether each secret is set and when it changed; never the value or its size. */
export async function readSecretStatuses(db: Db): Promise<SecretStatuses> {
  const rows = await db
    .select({ name: workspaceSecrets.name, updatedAt: workspaceSecrets.updatedAt })
    .from(workspaceSecrets);
  const byName = new Map(rows.map((r) => [r.name, r.updatedAt]));
  return Object.fromEntries(
    WORKSPACE_SECRET_NAMES.map((name) => [
      name,
      { set: byName.has(name), updatedAt: byName.get(name) ?? null },
    ]),
  ) as SecretStatuses;
}

/**
 * Decrypts every stored secret. A value that cannot be decrypted (wrong key, moved, damaged) is
 * reported in `unreadable` by name and left out of `values`. The values are wrapped in `Secret`.
 */
export async function readSecrets(
  db: Db,
  key: EncryptionKey,
): Promise<{
  values: Partial<Record<WorkspaceSecretName, Secret<string>>>;
  unreadable: WorkspaceSecretName[];
}> {
  const rows = await db.select().from(workspaceSecrets);
  const values: Partial<Record<WorkspaceSecretName, Secret<string>>> = {};
  const unreadable: WorkspaceSecretName[] = [];
  for (const row of rows) {
    const name = row.name as WorkspaceSecretName;
    try {
      values[name] = new Secret(decryptSecret(key, name, row));
    } catch {
      unreadable.push(name);
    }
  }
  return { values, unreadable };
}

/** The field paths whose values differ, e.g. `github.appId`, `limits.maxFileBytes`, `repos`. */
export function changedPaths(before: unknown, after: unknown): string[] {
  const leaves = (
    value: unknown,
    prefix: string,
    out: Map<string, string>,
  ): Map<string, string> => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value))
        leaves(v, prefix === "" ? k : `${prefix}.${k}`, out);
    } else {
      out.set(prefix, JSON.stringify(value) ?? "undefined");
    }
    return out;
  };
  const a = leaves(before, "", new Map());
  const b = leaves(after, "", new Map());
  const paths = new Set([...a.keys(), ...b.keys()]);
  return [...paths].filter((p) => a.get(p) !== b.get(p)).sort();
}

export interface WorkspaceChange {
  /** The administrator making the change, or null for a system caller. */
  readonly userId: number | null;
  /** The version the form was loaded from (`UNSAVED_VERSION` for a workspace never saved). */
  readonly expectedVersion: number;
  /** The full new settings (unvalidated input), or undefined to leave them as they are. */
  readonly settings?: unknown;
  /** A string sets or replaces a secret, `null` clears it, a missing key keeps it. */
  readonly secrets?: Partial<Record<WorkspaceSecretName, string | null>>;
}

export type SaveResult =
  | { readonly ok: true; readonly version: number; readonly changed: readonly string[] }
  | { readonly ok: false; readonly reason: "invalid"; readonly problems: readonly string[] }
  | { readonly ok: false; readonly reason: "conflict" };

/**
 * Validates and saves a change. Validation problems name fields and never echo values. A stale
 * `expectedVersion` saves nothing. Secrets need the encryption key; without it a secret change is
 * refused as invalid. The change bumps the version, which is how caches elsewhere notice it.
 */
export async function saveWorkspace(
  db: Db,
  key: EncryptionKey | null,
  change: WorkspaceChange,
): Promise<SaveResult> {
  const problems: string[] = [];

  let nextSettings: AppConfig | undefined;
  if (change.settings !== undefined) {
    const parsed = configSchema.safeParse(change.settings, { reportInput: false });
    if (parsed.success) nextSettings = parsed.data;
    else problems.push(...formatConfigIssues(parsed.error));
  }

  const secretWrites: [WorkspaceSecretName, string | null][] = [];
  for (const [rawName, value] of Object.entries(change.secrets ?? {})) {
    if (value === undefined) continue;
    const name = rawName as WorkspaceSecretName;
    if (!WORKSPACE_SECRET_NAMES.includes(name)) {
      problems.push(`${rawName}: unknown secret`);
      continue;
    }
    if (value === null) {
      secretWrites.push([name, null]);
      continue;
    }
    const problem = secretProblem(name, value);
    if (problem !== null) problems.push(problem);
    else secretWrites.push([name, normalizeSecret(name, value)]);
  }
  if (secretWrites.some(([, v]) => v !== null) && key === null) {
    problems.push("SETTINGS_ENCRYPTION_KEY: is not set or invalid, so secrets cannot be saved");
  }
  if (problems.length > 0) return { ok: false, reason: "invalid", problems };

  return db.transaction(async (tx): Promise<SaveResult> => {
    const current = await readSettings(tx as unknown as Db);
    const changed: string[] = [];
    if (nextSettings) changed.push(...changedPaths(current.settings, nextSettings));
    for (const [name] of secretWrites) changed.push(`secret:${name}`);

    // Nothing to write: a stale base is still reported, so the form never looks saved when not.
    if (current.version !== change.expectedVersion) return { ok: false, reason: "conflict" };
    if (changed.length === 0 && nextSettings === undefined && secretWrites.length === 0) {
      return { ok: true, version: current.version, changed };
    }

    const now = new Date();
    const data = (nextSettings ?? current.settings) as unknown as Record<string, unknown>;
    let version: number;
    if (current.version === UNSAVED_VERSION) {
      const inserted = await tx
        .insert(workspaceSettings)
        .values({ id: SETTINGS_ROW_ID, data, version: 1, updatedAt: now, updatedBy: change.userId })
        .onConflictDoNothing()
        .returning({ version: workspaceSettings.version });
      if (inserted.length === 0) return { ok: false, reason: "conflict" };
      version = 1;
    } else {
      const updated = await tx
        .update(workspaceSettings)
        .set({
          data,
          version: sql`${workspaceSettings.version} + 1`,
          updatedAt: now,
          updatedBy: change.userId,
        })
        .where(
          sql`${workspaceSettings.id} = ${SETTINGS_ROW_ID} and ${workspaceSettings.version} = ${current.version}`,
        )
        .returning({ version: workspaceSettings.version });
      if (updated.length === 0) return { ok: false, reason: "conflict" };
      version = updated[0]!.version;
    }

    for (const [name, value] of secretWrites) {
      if (value === null) {
        await tx.delete(workspaceSecrets).where(eq(workspaceSecrets.name, name));
        continue;
      }
      const encrypted = encryptSecret(key as EncryptionKey, name, value);
      const set = { ...encrypted, updatedAt: now, updatedBy: change.userId };
      await tx
        .insert(workspaceSecrets)
        .values({ name, ...set })
        .onConflictDoUpdate({ target: workspaceSecrets.name, set });
    }

    if (changed.length > 0) {
      await tx.insert(settingsAudit).values({ userId: change.userId, fields: changed });
    }
    return { ok: true, version, changed };
  });
}

/** Logs a successful change: fixed event name, ids and field names, never values. */
export function logSettingsChange(userId: number | null, changed: readonly string[]): void {
  logger.info("settings.changed", { userId, fields: changed });
}

export function logSettingsFailure(error: unknown): void {
  logger.error("settings.save_failed", errorFields(error));
}
