import { requireAdmin, type CurrentUser } from "../auth/current-user";
import { type Db, type DbInput, resolveDb } from "../db/client";
import { settingsAudit } from "../db/schema";
import { errorFields, logger, type Logger } from "../log";
import { listRepoIds } from "../queries";
import { anonymousReposOnly } from "../queries/visibility";
import {
  checkPublicAccessChange,
  readPublicAccessSettings,
  savePublicAccessSettings,
  type PublicAccessSettings,
} from "../public-access/settings";
import { adminOrDenied, fieldError, noStore, readJsonBody } from "./http";

/**
 * Admin API for the public access settings (public-access design decision 4):
 * `GET /api/admin/public-access` and `PUT /api/admin/public-access`. Every handler requires an
 * admin session first; the write also requires a same-origin JSON request. A save is recorded in
 * `settings_audit` by field name only, never by value.
 */

export interface PublicAccessAdminDeps {
  readonly db: DbInput;
  readonly tenantId?: string;
  readonly log?: Logger;
  /** Resolves the admin (default `requireAdmin`, which throws 401/403). Tests only. */
  readonly admin?: (db: Db) => Promise<CurrentUser>;
}

/** What the admin page shows: the settings and whether anything is public yet. */
export interface PublicAccessAdminView {
  readonly settings: PublicAccessSettings;
  /** At least one allowed repository is public (on its own or through a folder). */
  readonly anyPublic: boolean;
}

const MAX_BODY_CHARS = 1024;

async function view(db: Db): Promise<PublicAccessAdminView> {
  const [settings, ids] = await Promise.all([
    readPublicAccessSettings(db),
    listRepoIds(db, { visibility: anonymousReposOnly }),
  ]);
  return { settings, anyPublic: ids.length > 0 };
}

/** The view for the admin page (a server component). Throws 401/403 errors on denial. */
export async function getPublicAccessAdminView(
  deps: PublicAccessAdminDeps,
): Promise<PublicAccessAdminView> {
  const db = await resolveDb(deps.db);
  await (deps.admin ?? requireAdmin)(db);
  return view(db);
}

/** `GET /api/admin/public-access`. */
export async function handleGetPublicAccess(deps: PublicAccessAdminDeps): Promise<Response> {
  try {
    const db = await resolveDb(deps.db);
    const who = await adminOrDenied(deps.admin, db);
    if ("denied" in who) return who.denied;
    return noStore(await view(db));
  } catch (error) {
    (deps.log ?? logger).error("public_access.admin.failed", {
      action: "get",
      ...errorFields(error),
    });
    return noStore({ error: "Internal error" }, 500);
  }
}

/**
 * `PUT /api/admin/public-access` with any of `{ searchEnabled, askEnabled, askQuestionsPerDay,
 * askQuestionsPerTenMinutes }`. Fields left out keep their value.
 */
export async function handleSavePublicAccess(
  request: Request,
  deps: PublicAccessAdminDeps,
): Promise<Response> {
  const log = deps.log ?? logger;
  try {
    const db = await resolveDb(deps.db);
    const who = await adminOrDenied(deps.admin, db);
    if ("denied" in who) return who.denied;
    const body = await readJsonBody(request, MAX_BODY_CHARS);
    if ("denied" in body) return body.denied;

    const checked = checkPublicAccessChange(body.value);
    if (!checked.ok) return fieldError(checked.field, checked.error);
    const fields = Object.keys(checked.value);
    if (fields.length === 0) return fieldError("body", "Send at least one setting");

    const adminId = who.admin.id > 0 ? who.admin.id : null;
    await savePublicAccessSettings(db, checked.value, adminId);
    await db.insert(settingsAudit).values({
      userId: adminId,
      fields: fields.map((name) => `publicAccess.${name}`),
    });
    log.info("public_access.settings.changed", { adminId: who.admin.id, fields });
    return noStore(await view(db));
  } catch (error) {
    log.error("public_access.admin.failed", { action: "save", ...errorFields(error) });
    return noStore({ error: "Internal error" }, 500);
  }
}
