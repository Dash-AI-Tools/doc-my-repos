import { eq, max } from "drizzle-orm";

import type { Db } from "../db/client";
import { repoFolders, repos } from "../db/schema";

type Failure = {
  ok: false;
  status: 400 | 404 | 409;
  error: string;
  /** `confirm_private`: public access was asked for a GitHub-private repository without confirmation. */
  code?: "confirm_private";
  privateRepos?: number;
};

export type RepoFlags = {
  owner: string;
  name: string;
  isAllowed: boolean;
  isPublic: boolean;
  isStarred: boolean;
  starPosition: number | null;
  folderId: number | null;
};
export type UpdateFlagsResult =
  ({ ok: true; githubId: number; wasAllowed: boolean; wasPublic: boolean } & RepoFlags) | Failure;
export type SetAllowedResult =
  { ok: true; owner: string; name: string; isAllowed: boolean } | Failure;
export type SetStarredResult =
  | { ok: true; owner: string; name: string; isStarred: boolean; starPosition: number | null }
  | Failure;
export type ReorderResult = { ok: true; repos: { owner: string; name: string }[] } | Failure;

type RepoRow = {
  id: number;
  githubId: number;
  owner: string;
  name: string;
  visibility: "public" | "private";
  isAllowed: boolean;
  isPublic: boolean;
  starPosition: number | null;
  folderId: number | null;
};

/** What the admin helpers need from a database or a transaction. */
type Reader = Pick<Db, "select">;

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
const keyOf = (owner: string, name: string): string =>
  `${owner.trim().toLowerCase()}/${name.trim().toLowerCase()}`;

/**
 * Owner/name match case-insensitively, like the read layer; the repos table is small (one row per
 * repo) and these are admin-only actions, so a single scan is enough.
 */
async function findRepo(
  db: Reader,
  owner: string,
  name: string,
): Promise<{ ok: true; repo: RepoRow } | Failure> {
  const wanted = keyOf(owner, name);
  const all = await db
    .select({
      id: repos.id,
      githubId: repos.githubId,
      owner: repos.owner,
      name: repos.name,
      visibility: repos.visibility,
      isAllowed: repos.isAllowed,
      isPublic: repos.isPublic,
      starPosition: repos.starPosition,
      folderId: repos.folderId,
    })
    .from(repos);
  const repo = all.find((r) => keyOf(r.owner, r.name) === wanted);
  return repo ? { ok: true, repo } : { ok: false, status: 404, error: "repo not found" };
}

/**
 * Admin allow/block, star/unstar and folder assignment in one write. Each present flag (`undefined` = absent) is
 * validated before anything is written, and at least one must be present. Content is kept when a
 * repo is blocked: the visibility chokepoint hides it from every read, and re-allowing restores it
 * without re-syncing. Starring appends at `max + 1`; starring a starred repo keeps its place;
 * unstarring clears it. Blocking never touches the star or its place. `folderId` (a folder id, or
 * null to clear; absent = leave alone) must name an existing folder, else 404. `isPublic` makes the
 * repository readable without signing in; for a repository that is private on GitHub it needs
 * `confirmPrivate: true` (else 409 `confirm_private`), because its documents become readable by
 * anyone. Turning it off never needs confirmation.
 */
export async function updateRepoFlags(
  db: Db,
  owner: unknown,
  name: unknown,
  flags: {
    isAllowed?: unknown;
    isStarred?: unknown;
    folderId?: unknown;
    isPublic?: unknown;
    confirmPrivate?: unknown;
  },
): Promise<UpdateFlagsResult> {
  if (!nonEmpty(owner) || !nonEmpty(name)) {
    return { ok: false, status: 400, error: "owner and name are required" };
  }
  const { isAllowed, isStarred, folderId, isPublic, confirmPrivate } = flags;
  if (isAllowed !== undefined && typeof isAllowed !== "boolean") {
    return { ok: false, status: 400, error: "isAllowed: must be a boolean" };
  }
  if (isStarred !== undefined && typeof isStarred !== "boolean") {
    return { ok: false, status: 400, error: "isStarred: must be a boolean" };
  }
  if (
    folderId !== undefined &&
    folderId !== null &&
    !(typeof folderId === "number" && Number.isSafeInteger(folderId) && folderId > 0)
  ) {
    return { ok: false, status: 400, error: "folderId: must be a folder id or null" };
  }
  if (isPublic !== undefined && typeof isPublic !== "boolean") {
    return { ok: false, status: 400, error: "isPublic: must be a boolean" };
  }
  if (confirmPrivate !== undefined && typeof confirmPrivate !== "boolean") {
    return { ok: false, status: 400, error: "confirmPrivate: must be a boolean" };
  }
  if (
    isAllowed === undefined &&
    isStarred === undefined &&
    folderId === undefined &&
    isPublic === undefined
  ) {
    return {
      ok: false,
      status: 400,
      error: "isAllowed, isStarred, isPublic or folderId is required",
    };
  }
  return db.transaction(async (tx): Promise<UpdateFlagsResult> => {
    const found = await findRepo(tx, owner, name);
    if (!found.ok) return found;
    const { repo } = found;
    const set: Partial<typeof repos.$inferInsert> = { updatedAt: new Date() };
    if (isAllowed !== undefined) set.isAllowed = isAllowed;
    if (
      isPublic === true &&
      !repo.isPublic &&
      repo.visibility === "private" &&
      confirmPrivate !== true
    ) {
      return {
        ok: false,
        status: 409,
        error:
          "This repository is private on GitHub; confirm to make its documents readable by anyone",
        code: "confirm_private",
        privateRepos: 1,
      };
    }
    if (isPublic !== undefined) set.isPublic = isPublic;
    if (folderId !== undefined) {
      if (folderId !== null) {
        const [folder] = await tx
          .select({ id: repoFolders.id })
          .from(repoFolders)
          .where(eq(repoFolders.id, folderId));
        if (!folder) return { ok: false, status: 404, error: "folder not found" };
      }
      set.folderId = folderId;
    }
    if (isStarred === false) set.starPosition = null;
    if (isStarred === true && repo.starPosition === null) {
      const [row] = await tx.select({ top: max(repos.starPosition) }).from(repos);
      set.starPosition = (row?.top ?? -1) + 1;
    }
    await tx.update(repos).set(set).where(eq(repos.id, repo.id));
    return {
      ok: true,
      githubId: repo.githubId,
      wasAllowed: repo.isAllowed,
      wasPublic: repo.isPublic,
      owner: repo.owner,
      name: repo.name,
      isAllowed: set.isAllowed ?? repo.isAllowed,
      isPublic: set.isPublic ?? repo.isPublic,
      isStarred: (set.starPosition === undefined ? repo.starPosition : set.starPosition) !== null,
      starPosition: set.starPosition === undefined ? repo.starPosition : set.starPosition,
      folderId: set.folderId === undefined ? repo.folderId : set.folderId,
    };
  });
}

export async function setRepoAllowed(
  db: Db,
  owner: unknown,
  name: unknown,
  isAllowed: unknown,
): Promise<SetAllowedResult> {
  // `undefined` would read as "absent"; a missing value is invalid here.
  const result = await updateRepoFlags(db, owner, name, { isAllowed: isAllowed ?? null });
  return result.ok
    ? { ok: true, owner: result.owner, name: result.name, isAllowed: result.isAllowed }
    : result;
}

export async function setRepoStarred(
  db: Db,
  owner: unknown,
  name: unknown,
  isStarred: unknown,
): Promise<SetStarredResult> {
  const result = await updateRepoFlags(db, owner, name, { isStarred: isStarred ?? null });
  return result.ok
    ? {
        ok: true,
        owner: result.owner,
        name: result.name,
        isStarred: result.isStarred,
        starPosition: result.starPosition,
      }
    : result;
}

/**
 * Sets the starred order from the complete list of starred repos in the wanted order. In one
 * transaction (rows locked, so a concurrent star or unstar waits): malformed, repeated or unknown
 * entries are 400; a list that is not exactly the currently starred set is 409 (a stale client
 * must not overwrite a concurrent change). Positions are rewritten to `0..n-1`, which also
 * closes any gaps. Blocked repos are ordinary members.
 */
export async function reorderStarredRepos(db: Db, list: unknown): Promise<ReorderResult> {
  if (!Array.isArray(list)) return { ok: false, status: 400, error: "repos: must be a list" };
  const wanted: string[] = [];
  for (const entry of list as unknown[]) {
    const { owner, name } = (typeof entry === "object" && entry !== null ? entry : {}) as {
      owner?: unknown;
      name?: unknown;
    };
    if (!nonEmpty(owner) || !nonEmpty(name)) {
      return { ok: false, status: 400, error: "repos: each entry needs an owner and a name" };
    }
    wanted.push(keyOf(owner, name));
  }
  if (new Set(wanted).size !== wanted.length) {
    return { ok: false, status: 400, error: "repos: a repository is listed twice" };
  }
  return db.transaction(async (tx): Promise<ReorderResult> => {
    const all = await tx
      .select({
        id: repos.id,
        owner: repos.owner,
        name: repos.name,
        starPosition: repos.starPosition,
      })
      .from(repos)
      .for("update");
    const byKey = new Map(all.map((r) => [keyOf(r.owner, r.name), r]));
    const ordered = [];
    for (const key of wanted) {
      const repo = byKey.get(key);
      if (!repo) return { ok: false, status: 400, error: "repos: unknown repository" };
      ordered.push(repo);
    }
    const starredCount = all.filter((r) => r.starPosition !== null).length;
    if (ordered.length !== starredCount || ordered.some((r) => r.starPosition === null)) {
      return {
        ok: false,
        status: 409,
        error: "The starred list changed; reload and try again",
      };
    }
    for (const [position, repo] of ordered.entries()) {
      await tx.update(repos).set({ starPosition: position }).where(eq(repos.id, repo.id));
    }
    return { ok: true, repos: ordered.map((r) => ({ owner: r.owner, name: r.name })) };
  });
}
