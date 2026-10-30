import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";

import { PUBLIC_USERS, type PublicUser } from "./public-access-data";
import { stackUrl } from "./stack";

/**
 * Helpers of the public access e2e specs, which run on the `publicaccess` server: no auth bypass,
 * so a session is a real one (`signIn`) and a context with no cookie is an anonymous visitor.
 */

const BASE = stackUrl("publicaccess");

export interface Visitor {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly close: () => Promise<void>;
}

export interface VisitorOptions {
  readonly theme?: "light" | "dark";
  readonly viewport?: { readonly width: number; readonly height: number };
}

async function open(browser: Browser, options: VisitorOptions): Promise<Visitor> {
  const context = await browser.newContext({
    baseURL: BASE,
    ...(options.viewport ? { viewport: options.viewport } : {}),
  });
  if (options.theme) {
    await context.addInitScript(
      (value) => localStorage.setItem("docmyrepos-theme", value),
      options.theme,
    );
  }
  return { context, page: await context.newPage(), close: () => context.close() };
}

/** A visitor with no session at all. */
export function anonymous(browser: Browser, options: VisitorOptions = {}): Promise<Visitor> {
  return open(browser, options);
}

/** A visitor who signed in through the real login route. */
export async function signedIn(
  browser: Browser,
  user: PublicUser,
  options: VisitorOptions = {},
): Promise<Visitor> {
  const visitor = await open(browser, options);
  const response = await visitor.context.request.post("/api/auth/login", {
    headers: { Origin: BASE },
    data: { email: PUBLIC_USERS[user].email, password: PUBLIC_USERS[user].password },
  });
  if (!response.ok()) throw new Error(`sign-in as ${user} failed (${response.status()})`);
  return visitor;
}

/** A write to an admin API from a signed-in context (same-origin, as the pages do). */
export async function adminWrite(
  request: APIRequestContext,
  method: "PATCH" | "PUT" | "POST",
  path: string,
  data: unknown,
) {
  return request.fetch(path, { method, headers: { Origin: BASE }, data });
}

/** Sets or clears public access of a repository through the admin API. */
export async function setRepoPublic(
  request: APIRequestContext,
  repo: { readonly owner: string; readonly name: string },
  isPublic: boolean,
): Promise<void> {
  const response = await adminWrite(request, "PATCH", "/api/admin/repos", {
    ...repo,
    isPublic,
    confirmPrivate: true,
  });
  if (!response.ok()) throw new Error(`repo public=${isPublic} failed (${response.status()})`);
}

/** Creates a folder (or finds it by name) and sets whether it is public; returns its id. */
export async function ensureFolder(
  request: APIRequestContext,
  name: string,
  isPublic: boolean,
): Promise<number> {
  const listed = await request.get("/api/admin/folders");
  const existing = (
    (await listed.json()) as { folders: { id: number; name: string }[] }
  ).folders.find((f) => f.name === name);
  let id = existing?.id;
  if (id === undefined) {
    const created = await adminWrite(request, "POST", "/api/admin/folders", { name });
    id = ((await created.json()) as { folder: { id: number } }).folder.id;
  }
  const patched = await adminWrite(request, "PATCH", `/api/admin/folders/${id}`, {
    isPublic,
    confirmPrivate: true,
  });
  if (!patched.ok()) throw new Error(`folder public=${isPublic} failed (${patched.status()})`);
  return id;
}

/** Puts a repository in a folder (or out of it with null). */
export async function setRepoFolder(
  request: APIRequestContext,
  repo: { readonly owner: string; readonly name: string },
  folderId: number | null,
): Promise<void> {
  const response = await adminWrite(request, "PATCH", "/api/admin/repos", { ...repo, folderId });
  if (!response.ok()) throw new Error(`repo folder failed (${response.status()})`);
}

/** Turns every public mark off, so a spec starts from "nothing is public". */
export async function clearPublic(request: APIRequestContext): Promise<void> {
  const repos = (
    (await (await request.get("/api/admin/repos")).json()) as {
      repos: { owner: string; name: string; isPublic: boolean; folderId: number | null }[];
    }
  ).repos;
  for (const r of repos) {
    if (r.isPublic) await setRepoPublic(request, r, false);
  }
  const folders = (
    (await (await request.get("/api/admin/folders")).json()) as {
      folders: { id: number; isPublic: boolean }[];
    }
  ).folders;
  for (const f of folders) {
    if (f.isPublic) {
      await adminWrite(request, "PATCH", `/api/admin/folders/${f.id}`, { isPublic: false });
    }
  }
}
