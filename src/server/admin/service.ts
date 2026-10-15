import { getDb, type Db } from "@/server/db/client";
import { authErrorResponse, requireAdmin } from "@/server/auth/current-user";
import { readGithubConfigSummary } from "@/server/admin/github-config";
import { setRepoAllowed } from "@/server/admin/repos";
import { createUser, listUsers, updateUser } from "@/server/admin/users";
import { readBrandingSettings } from "@/server/branding";
import { siteBranding } from "@/server/db/schema";
import { parseBrandColor, parseOrgName, parsePageTitle } from "@/lib/branding/validate";
import { allowAllRepos, type QueryOptions } from "@/server/queries/visibility";
import { listRepos } from "@/server/queries/repos";

/**
 * Handler bodies for the thin route files under `src/app/api/admin/`. They own the database
 * access so routes stay out of `server/db` (see the layering guard in
 * `src/server/queries/enforcement.test.ts`). Every handler requires an admin session first.
 */

async function guard(db: Db | null = null): Promise<Response | null> {
  try {
    await requireAdmin(db);
    return null;
  } catch (error) {
    return authErrorResponse(error);
  }
}

/** Data readers for admin pages (server components). Throw 401/403 errors on denial. */
export async function getAdminUsers(db: Db | null = null) {
  await requireAdmin(db);
  return listUsers(db ?? getDb().db);
}

/** Full repo list for the admin panel, blocked included (trusted caller, explicit filter). */
export async function getAdminRepos(db: Db | null = null) {
  await requireAdmin(db);
  const options: QueryOptions = { visibility: allowAllRepos };
  return listRepos(db ?? getDb().db, {}, options);
}

/** Read-only GitHub/sync configuration summary. Secrets are never included. */
export async function getAdminGithubConfig(db: Db | null = null) {
  await requireAdmin(db);
  return readGithubConfigSummary();
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

export async function handleListUsers(db: Db | null = null): Promise<Response> {
  try {
    return Response.json({ users: await getAdminUsers(db) });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function handleCreateUser(request: Request, db: Db | null = null): Promise<Response> {
  const denied = await guard(db);
  if (denied) return denied;
  const parsed = await bodyOf(request);
  if ("error" in parsed) return parsed.error;
  try {
    const result = await createUser(db ?? getDb().db, {
      email: parsed.body.email,
      password: parsed.body.password,
      role: parsed.body.role,
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ user: result.user }, { status: 201 });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function handleUpdateUser(
  id: number,
  request: Request,
  db: Db | null = null,
): Promise<Response> {
  const denied = await guard(db);
  if (denied) return denied;
  const parsed = await bodyOf(request);
  if ("error" in parsed) return parsed.error;
  try {
    const result = await updateUser(db ?? getDb().db, id, {
      role: parsed.body.role,
      disabled: parsed.body.disabled,
      password: parsed.body.password,
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ user: result.user });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/** Full repo list for the admin panel, blocked included (trusted caller, explicit filter). */
export async function handleListRepos(db: Db | null = null): Promise<Response> {
  try {
    return Response.json({ repos: await getAdminRepos(db) });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function handleSetRepoAllowed(
  request: Request,
  db: Db | null = null,
): Promise<Response> {
  const denied = await guard(db);
  if (denied) return denied;
  const parsed = await bodyOf(request);
  if ("error" in parsed) return parsed.error;
  try {
    const result = await setRepoAllowed(
      db ?? getDb().db,
      parsed.body.owner,
      parsed.body.name,
      parsed.body.isAllowed,
    );
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ repo: result });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/** Read-only GitHub/sync configuration summary. Secrets are never included. */
export async function handleGithubConfig(db: Db | null = null): Promise<Response> {
  try {
    return Response.json({ config: await getAdminGithubConfig(db) });
  } catch (error) {
    return authErrorResponse(error);
  }
}

/** `GET /api/admin/branding`: current settings, logo version, no bytes. */
export async function handleGetBranding(db: Db | null = null): Promise<Response> {
  const denied = await guard(db);
  if (denied) return denied;
  try {
    return Response.json({ branding: await readBrandingSettings(db) });
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
  db: Db | null = null,
): Promise<Response> {
  const denied = await guard(db);
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
    const target = db ?? getDb().db;
    if (Object.keys(patch).length > 0) {
      await target
        .insert(siteBranding)
        .values({ id: 1, ...patch, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: siteBranding.id,
          set: { ...patch, updatedAt: new Date() },
        });
    }
    return Response.json({ branding: await readBrandingSettings(target) });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/** `DELETE /api/admin/branding`: reset everything, including the logo. */
export async function handleResetBranding(db: Db | null = null): Promise<Response> {
  const denied = await guard(db);
  if (denied) return denied;
  try {
    const target = db ?? getDb().db;
    await target.delete(siteBranding);
    return Response.json({ branding: await readBrandingSettings(target) });
  } catch {
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
