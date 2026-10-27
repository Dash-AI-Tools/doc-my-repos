import { type DbInput, resolveDb } from "../db/client";
import { runAuthorizedSync, type ManualSyncService } from "../sync/manual-sync";
import { getSyncService } from "../sync/service";
import { type Access, legacyAccess } from "../auth/access";
import { authErrorResponse } from "../auth/current-user";
import { createFolder, deleteFolder, reorderStarredFolders, updateFolder } from "./folders";
import { reorderStarredRepos, updateRepoFlags } from "./repos";
import { createUser, listUsers, updateUser } from "./users";
import {
  columnLogoStore,
  LOGO_CONTENT_TYPES,
  readBrandingSettings,
  recordLogoChange,
  type LogoStore,
  type LogoType,
} from "../branding";
import { siteBranding } from "../db/schema";
import { sniffImageType } from "../assets/image-types";
import {
  parseBrandColor,
  parseOrgName,
  parsePageTitle,
} from "@docmyrepos/core/internal/branding/validate";
import { allowAllRepos, type QueryOptions } from "../queries/visibility";
import { listFolders } from "../queries/folders";
import { listRepos } from "../queries/repos";

/**
 * Handler bodies for the thin route files under `src/app/api/admin/`. They own the database
 * access so routes stay out of `server/db` (see the layering guard in
 * `packages/server/src/queries/enforcement.test.ts`). Every handler requires an admin session first.
 */

/** The admin check of every handler: `access` from the request context, or the default rules. */
async function adminOf(db: DbInput, access: Access | undefined) {
  return (access ?? legacyAccess(await resolveDb(db))).admin();
}

async function guard(db: DbInput, access?: Access): Promise<Response | null> {
  try {
    await adminOf(db, access);
    return null;
  } catch (error) {
    return authErrorResponse(error);
  }
}

/** Data readers for admin pages (server components). Throw 401/403 errors on denial. */
export async function getAdminUsers(db: DbInput, access?: Access) {
  await adminOf(db, access);
  return listUsers(await resolveDb(db));
}

/** Full repo list for the admin panel, blocked included (trusted caller, explicit filter). */
export async function getAdminRepos(db: DbInput, access?: Access) {
  await adminOf(db, access);
  const options: QueryOptions = { visibility: allowAllRepos };
  return listRepos(await resolveDb(db), {}, options);
}

/** Folder list for the admin panel (server component). Throws 401/403 errors on denial. */
export async function getAdminFolders(db: DbInput, access?: Access) {
  await adminOf(db, access);
  return listFolders(await resolveDb(db));
}

async function bodyOf(
  request: Request,
): Promise<{ body: Record<string, unknown> } | { error: Response }> {
  try {
    return { body: (await request.json()) as Record<string, unknown> };
  } catch {
    return { error: Response.json({ error: "invalid JSON body" }, { status: 400 }) };
  }
}

export async function handleListUsers(db: DbInput, access?: Access): Promise<Response> {
  try {
    return Response.json({ users: await getAdminUsers(db, access) });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function handleCreateUser(
  request: Request,
  db: DbInput,
  access?: Access,
): Promise<Response> {
  const denied = await guard(db, access);
  if (denied) return denied;
  const parsed = await bodyOf(request);
  if ("error" in parsed) return parsed.error;
  try {
    const result = await createUser(await resolveDb(db), {
      email: parsed.body.email,
      password: parsed.body.password,
      role: parsed.body.role,
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    access?.emit({
      name: "user.created",
      payload: { userId: result.user.id, role: result.user.role },
    });
    return Response.json({ user: result.user }, { status: 201 });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function handleUpdateUser(
  id: number,
  request: Request,
  db: DbInput,
  access?: Access,
): Promise<Response> {
  let actorId: number;
  try {
    actorId = (await adminOf(db, access)).id;
  } catch (error) {
    return authErrorResponse(error);
  }
  const parsed = await bodyOf(request);
  if ("error" in parsed) return parsed.error;
  try {
    const result = await updateUser(
      await resolveDb(db),
      id,
      {
        role: parsed.body.role,
        disabled: parsed.body.disabled,
        password: parsed.body.password,
      },
      actorId,
    );
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    access?.emit({
      name: "user.updated",
      payload: {
        userId: id,
        fields: (["role", "disabled", "password"] as const).filter(
          (field) => parsed.body[field] !== undefined,
        ),
      },
      actorId,
    });
    return Response.json({ user: result.user });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/** Full repo list for the admin panel, blocked included (trusted caller, explicit filter). */
export async function handleListRepos(db: DbInput, access?: Access): Promise<Response> {
  try {
    return Response.json({ repos: await getAdminRepos(db, access) });
  } catch (error) {
    return authErrorResponse(error);
  }
}

/** `PATCH /api/admin/repos`: `{owner, name}` plus `isAllowed` and/or `isStarred` (booleans) and/or `folderId` (id or null). */
export async function handleUpdateRepo(
  request: Request,
  db: DbInput,
  access?: Access,
): Promise<Response> {
  const denied = await guard(db, access);
  if (denied) return denied;
  const parsed = await bodyOf(request);
  if ("error" in parsed) return parsed.error;
  try {
    const result = await updateRepoFlags(await resolveDb(db), parsed.body.owner, parsed.body.name, {
      isAllowed: parsed.body.isAllowed,
      isStarred: parsed.body.isStarred,
      folderId: parsed.body.folderId,
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    if (result.isAllowed !== result.wasAllowed) {
      access?.emit({
        name: "repo.access_changed",
        payload: { githubRepoId: result.githubId, allowed: result.isAllowed },
      });
    }
    return Response.json({
      repo: { ...result, ok: undefined, githubId: undefined, wasAllowed: undefined },
    });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/** `PUT /api/admin/repos/starred`: `{repos: [{owner, name}, ...]}`, the whole starred list in order. */
export async function handleReorderStarred(
  request: Request,
  db: DbInput,
  access?: Access,
): Promise<Response> {
  const denied = await guard(db, access);
  if (denied) return denied;
  const parsed = await bodyOf(request);
  if ("error" in parsed) return parsed.error;
  try {
    const result = await reorderStarredRepos(await resolveDb(db), parsed.body?.repos);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ repos: result.repos });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/** `GET /api/admin/folders`: every folder, starred first in order. */
export async function handleListFolders(db: DbInput, access?: Access): Promise<Response> {
  try {
    return Response.json({ folders: await getAdminFolders(db, access) });
  } catch (error) {
    return authErrorResponse(error);
  }
}

/** `POST /api/admin/folders` with `{name, description?}`. */
export async function handleCreateFolder(
  request: Request,
  db: DbInput,
  access?: Access,
): Promise<Response> {
  const denied = await guard(db, access);
  if (denied) return denied;
  const parsed = await bodyOf(request);
  if ("error" in parsed) return parsed.error;
  try {
    const result = await createFolder(await resolveDb(db), parsed.body ?? {});
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ folder: result.folder }, { status: 201 });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/** `PATCH /api/admin/folders/:id` with any of `{name, description, isStarred}`. */
export async function handleUpdateFolder(
  id: number,
  request: Request,
  db: DbInput,
  access?: Access,
): Promise<Response> {
  const denied = await guard(db, access);
  if (denied) return denied;
  const parsed = await bodyOf(request);
  if ("error" in parsed) return parsed.error;
  try {
    const body = parsed.body ?? {};
    const result = await updateFolder(await resolveDb(db), id, {
      name: body.name,
      description: body.description,
      isStarred: body.isStarred,
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ folder: result.folder });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/** `DELETE /api/admin/folders/:id`: its repositories are kept and become folderless. */
export async function handleDeleteFolder(
  id: number,
  db: DbInput,
  access?: Access,
): Promise<Response> {
  const denied = await guard(db, access);
  if (denied) return denied;
  try {
    const result = await deleteFolder(await resolveDb(db), id);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/** `PUT /api/admin/folders/starred`: `{folderIds: number[]}`, the whole starred list in order. */
export async function handleReorderFolders(
  request: Request,
  db: DbInput,
  access?: Access,
): Promise<Response> {
  const denied = await guard(db, access);
  if (denied) return denied;
  const parsed = await bodyOf(request);
  if ("error" in parsed) return parsed.error;
  try {
    const result = await reorderStarredFolders(await resolveDb(db), parsed.body?.folderIds);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ folderIds: result.folderIds });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/** Branding settings for the admin page (server component). Throws 401/403 on denial. */
export async function getAdminBranding(db: DbInput, access?: Access) {
  await adminOf(db, access);
  return readBrandingSettings(await resolveDb(db));
}

/** `GET /api/admin/branding`: current settings, logo version, no bytes. */
export async function handleGetBranding(db: DbInput, access?: Access): Promise<Response> {
  const denied = await guard(db, access);
  if (denied) return denied;
  try {
    return Response.json({ branding: await readBrandingSettings(await resolveDb(db)) });
  } catch (error) {
    return authErrorResponse(error);
  }
}

type BrandingPatch = Partial<{
  orgName: string | null;
  pageTitle: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  coloredHeader: boolean;
  invertLogoOnDark: boolean;
}>;

function brandingFieldError(field: string, message: string): Response {
  return Response.json({ error: message, field }, { status: 400 });
}

/** `PUT /api/admin/branding`: partial update; null/empty clears a field. */
export async function handleUpdateBranding(
  request: Request,
  db: DbInput,
  access?: Access,
): Promise<Response> {
  const denied = await guard(db, access);
  if (denied) return denied;
  const parsed = await bodyOf(request);
  if ("error" in parsed) return parsed.error;
  const body = parsed.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const patch: BrandingPatch = {};
  if ("orgName" in body) {
    const result = parseOrgName(body.orgName);
    if (!result.ok) return brandingFieldError("orgName", result.error);
    patch.orgName = result.value;
  }
  if ("pageTitle" in body) {
    const result = parsePageTitle(body.pageTitle);
    if (!result.ok) return brandingFieldError("pageTitle", result.error);
    patch.pageTitle = result.value;
  }
  if ("primaryColor" in body) {
    const result = parseBrandColor(body.primaryColor);
    if (!result.ok) return brandingFieldError("primaryColor", result.error);
    patch.primaryColor = result.value;
  }
  if ("accentColor" in body) {
    const result = parseBrandColor(body.accentColor);
    if (!result.ok) return brandingFieldError("accentColor", result.error);
    patch.accentColor = result.value;
  }
  for (const field of ["coloredHeader", "invertLogoOnDark"] as const) {
    if (field in body) {
      const value = body[field];
      if (value === null) {
        patch[field] = field === "coloredHeader" ? false : true;
      } else if (typeof value === "boolean") {
        patch[field] = value;
      } else {
        return brandingFieldError(field, `${field} must be a boolean`);
      }
    }
  }
  try {
    const target = await resolveDb(db);
    if (Object.keys(patch).length > 0) {
      await target
        .insert(siteBranding)
        .values({ id: 1, ...patch, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: siteBranding.id,
          set: { ...patch, updatedAt: new Date() },
        });
    }
    access?.emit({ name: "branding.updated", payload: { logoChanged: false } });
    return Response.json({ branding: await readBrandingSettings(target) });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/** `DELETE /api/admin/branding`: reset everything, including the logo. */
export async function handleResetBranding(
  db: DbInput,
  access?: Access,
  logo: LogoStore = columnLogoStore(db),
): Promise<Response> {
  const denied = await guard(db, access);
  if (denied) return denied;
  try {
    const target = await resolveDb(db);
    await logo.delete();
    await target.delete(siteBranding);
    access?.emit({ name: "branding.updated", payload: { logoChanged: false } });
    return Response.json({ branding: await readBrandingSettings(target) });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/** Logo uploads are capped at 512 KB; the stream is cut even when `Content-Length` lies. */
export const MAX_LOGO_BYTES = 512 * 1024;

async function readCappedBody(
  request: Request,
): Promise<{ bytes: Uint8Array } | { status: number; error: string }> {
  const reader = request.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0) };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_LOGO_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { status: 413, error: "logo must be at most 512 KB" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes };
}

/**
 * `PUT /api/admin/branding/logo`: raw body, type from bytes, version bump. The bytes go to `logo`,
 * the tenant's blob store (default: the `site_branding` row), once they pass validation.
 */
export async function handleUploadLogo(
  request: Request,
  db: DbInput,
  access?: Access,
  logo: LogoStore = columnLogoStore(db),
): Promise<Response> {
  const denied = await guard(db, access);
  if (denied) return denied;
  const declared = request.headers.get("content-length");
  if (declared === null || declared.trim() === "") {
    return Response.json({ error: "Content-Length is required", field: "logo" }, { status: 411 });
  }
  const declaredLength = Number(declared);
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
    return Response.json({ error: "Content-Length is invalid", field: "logo" }, { status: 400 });
  }
  if (declaredLength > MAX_LOGO_BYTES) {
    return Response.json({ error: "logo must be at most 512 KB", field: "logo" }, { status: 413 });
  }
  try {
    const target = await resolveDb(db);
    const read = await readCappedBody(request);
    if ("status" in read) {
      return Response.json({ error: read.error, field: "logo" }, { status: read.status });
    }
    if (read.bytes.length === 0) {
      return Response.json({ error: "logo must not be empty", field: "logo" }, { status: 400 });
    }
    const sniffed = sniffImageType(read.bytes);
    if (sniffed === null || !(sniffed in LOGO_CONTENT_TYPES)) {
      return Response.json(
        { error: "logo must be PNG, JPEG, WebP or SVG content", field: "logo" },
        { status: 400 },
      );
    }
    const type = sniffed as LogoType;
    await logo.put({ bytes: read.bytes, contentType: LOGO_CONTENT_TYPES[type] });
    await recordLogoChange(target, type);
    access?.emit({ name: "branding.updated", payload: { logoChanged: true } });
    return Response.json({ branding: await readBrandingSettings(target) });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/** `DELETE /api/admin/branding/logo`: remove the logo, bump the version. */
export async function handleRemoveLogo(
  db: DbInput,
  access?: Access,
  logo: LogoStore = columnLogoStore(db),
): Promise<Response> {
  const denied = await guard(db, access);
  if (denied) return denied;
  try {
    const target = await resolveDb(db);
    await logo.delete();
    await recordLogoChange(target, null);
    access?.emit({ name: "branding.updated", payload: { logoChanged: true } });
    return Response.json({ branding: await readBrandingSettings(target) });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/**
 * `POST /api/admin/sync`: the admin's "first sync" button. The same sync as `POST /api/sync`
 * (every repository, or the one the optional body names), authorized by the admin session instead
 * of `SYNC_SECRET`, which never reaches the browser.
 */
export async function handleAdminSync(
  request: Request,
  db: DbInput,
  access?: Access,
  getService: () => Promise<ManualSyncService> = getSyncService,
): Promise<Response> {
  const denied = await guard(db, access);
  if (denied) return denied;
  return runAuthorizedSync(request, { getService });
}
