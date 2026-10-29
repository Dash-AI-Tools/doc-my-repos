import { and, count, eq, max } from "drizzle-orm";

import type { Db } from "../db/client";
import { repoFolders, repos } from "../db/schema";

type Failure = {
  ok: false;
  status: 400 | 404 | 409;
  error: string;
  /** `confirm_private`: the folder holds repositories that are private on GitHub. */
  code?: "confirm_private";
  privateRepos?: number;
};

export const FOLDER_NAME_MAX = 80;
export const FOLDER_DESCRIPTION_MAX = 500;

export type FolderView = {
  id: number;
  name: string;
  description: string | null;
  starPosition: number | null;
  isStarred: boolean;
  /** Every allowed repository in it is readable without signing in (public access). */
  isPublic: boolean;
};
export type FolderResult =
  ({ ok: true } & { folder: FolderView; publicChanged: boolean }) | Failure;
export type DeleteFolderResult = { ok: true } | Failure;
export type ReorderFoldersResult = { ok: true; folderIds: number[] } | Failure;

const columns = {
  id: repoFolders.id,
  name: repoFolders.name,
  description: repoFolders.description,
  starPosition: repoFolders.starPosition,
  isPublic: repoFolders.isPublic,
};

const view = (row: Omit<FolderView, "isStarred">): FolderView => ({
  ...row,
  isStarred: row.starPosition !== null,
});

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Postgres unique violation, whether the driver error is wrapped (Drizzle `cause`) or not. */
function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown) =>
    typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return code(error) === "23505" || code((error as { cause?: unknown } | null)?.cause) === "23505";
}

const DUPLICATE: Failure = {
  ok: false,
  status: 409,
  error: "A folder with that name already exists",
};

function parseName(value: unknown): { ok: true; name: string } | Failure {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, status: 400, error: "name: required" };
  }
  const name = value.trim();
  if (name.length > FOLDER_NAME_MAX) {
    return { ok: false, status: 400, error: `name: at most ${FOLDER_NAME_MAX} characters` };
  }
  return { ok: true, name };
}

/** Empty or whitespace-only text is stored as null. */
function parseDescription(value: unknown): { ok: true; description: string | null } | Failure {
  if (value === null || value === undefined) return { ok: true, description: null };
  if (typeof value !== "string") {
    return { ok: false, status: 400, error: "description: must be text" };
  }
  const description = value.trim();
  if (description.length > FOLDER_DESCRIPTION_MAX) {
    return {
      ok: false,
      status: 400,
      error: `description: at most ${FOLDER_DESCRIPTION_MAX} characters`,
    };
  }
  return { ok: true, description: description === "" ? null : description };
}

export async function createFolder(
  db: Db,
  input: { name?: unknown; description?: unknown },
): Promise<FolderResult> {
  const name = parseName(input.name);
  if (!name.ok) return name;
  const description = parseDescription(input.description);
  if (!description.ok) return description;
  try {
    const [row] = await db
      .insert(repoFolders)
      .values({ name: name.name, description: description.description })
      .returning(columns);
    return { ok: true, folder: view(row!), publicChanged: false };
  } catch (error) {
    if (isUniqueViolation(error)) return DUPLICATE;
    throw error;
  }
}

/**
 * The allowed repositories in a folder that are private on GitHub: what making the folder public
 * would publish to anyone.
 */
export async function countPrivateRepos(db: Pick<Db, "select">, folderId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(repos)
    .where(
      and(eq(repos.folderId, folderId), eq(repos.isAllowed, true), eq(repos.visibility, "private")),
    );
  return row?.n ?? 0;
}

/** For every folder that holds any, the allowed repositories in it that are private on GitHub. */
export async function countPrivateReposByFolder(
  db: Pick<Db, "select">,
): Promise<Map<number, number>> {
  const rows = await db
    .select({ folderId: repos.folderId, n: count() })
    .from(repos)
    .where(and(eq(repos.isAllowed, true), eq(repos.visibility, "private")))
    .groupBy(repos.folderId);
  const counts = new Map<number, number>();
  for (const row of rows) if (row.folderId !== null) counts.set(row.folderId, row.n);
  return counts;
}

/**
 * Edits the fields that are present (`undefined` = leave alone); each is validated before anything
 * is written. Starring appends at `max + 1`, starring a starred folder keeps its place, unstarring
 * clears it. `isPublic` makes every allowed repository in the folder readable without signing in;
 * when that publishes repositories that are private on GitHub it needs `confirmPrivate: true`,
 * else 409 `confirm_private` with the count. Turning it off never needs confirmation.
 */
export async function updateFolder(
  db: Db,
  id: unknown,
  patch: {
    name?: unknown;
    description?: unknown;
    isStarred?: unknown;
    isPublic?: unknown;
    confirmPrivate?: unknown;
  },
): Promise<FolderResult> {
  if (!isId(id)) return { ok: false, status: 404, error: "folder not found" };
  const set: Partial<typeof repoFolders.$inferInsert> = {};
  if (patch.name !== undefined) {
    const name = parseName(patch.name);
    if (!name.ok) return name;
    set.name = name.name;
  }
  if (patch.description !== undefined) {
    const description = parseDescription(patch.description);
    if (!description.ok) return description;
    set.description = description.description;
  }
  if (patch.isStarred !== undefined && typeof patch.isStarred !== "boolean") {
    return { ok: false, status: 400, error: "isStarred: must be a boolean" };
  }
  if (patch.isPublic !== undefined && typeof patch.isPublic !== "boolean") {
    return { ok: false, status: 400, error: "isPublic: must be a boolean" };
  }
  if (patch.confirmPrivate !== undefined && typeof patch.confirmPrivate !== "boolean") {
    return { ok: false, status: 400, error: "confirmPrivate: must be a boolean" };
  }
  if (
    patch.name === undefined &&
    patch.description === undefined &&
    patch.isStarred === undefined &&
    patch.isPublic === undefined
  ) {
    return {
      ok: false,
      status: 400,
      error: "name, description, isStarred or isPublic is required",
    };
  }
  const isPublic = patch.isPublic as boolean | undefined; // checked above
  try {
    return await db.transaction(async (tx): Promise<FolderResult> => {
      const [current] = await tx
        .select(columns)
        .from(repoFolders)
        .where(eq(repoFolders.id, id))
        .for("update");
      if (!current) return { ok: false, status: 404, error: "folder not found" };
      if (patch.isPublic === true && !current.isPublic && patch.confirmPrivate !== true) {
        const privateRepos = await countPrivateRepos(tx, id);
        if (privateRepos > 0) {
          return {
            ok: false,
            status: 409,
            error: `This folder holds ${privateRepos} repositor${privateRepos === 1 ? "y" : "ies"} that ${privateRepos === 1 ? "is" : "are"} private on GitHub; confirm to make ${privateRepos === 1 ? "its documents" : "their documents"} readable by anyone`,
            code: "confirm_private",
            privateRepos,
          };
        }
      }
      if (isPublic !== undefined) set.isPublic = isPublic;
      if (patch.isStarred === false) set.starPosition = null;
      if (patch.isStarred === true && current.starPosition === null) {
        const [row] = await tx.select({ top: max(repoFolders.starPosition) }).from(repoFolders);
        set.starPosition = (row?.top ?? -1) + 1;
      }
      const [updated] = await tx
        .update(repoFolders)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(repoFolders.id, id))
        .returning(columns);
      return {
        ok: true,
        folder: view(updated!),
        publicChanged: patch.isPublic !== undefined && patch.isPublic !== current.isPublic,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return DUPLICATE;
    throw error;
  }
}

/** Deletes the folder; its repositories are kept and become folderless (`ON DELETE SET NULL`). */
export async function deleteFolder(db: Db, id: unknown): Promise<DeleteFolderResult> {
  if (!isId(id)) return { ok: false, status: 404, error: "folder not found" };
  const deleted = await db
    .delete(repoFolders)
    .where(eq(repoFolders.id, id))
    .returning({ id: repoFolders.id });
  return deleted.length > 0 ? { ok: true } : { ok: false, status: 404, error: "folder not found" };
}

/**
 * Sets the starred folder order from the complete list of starred folder ids in the wanted order.
 * One transaction with the rows locked: malformed, repeated or unknown ids are 400; a list that is
 * not exactly the currently starred set is 409 (a stale client must not overwrite a concurrent
 * change). Positions are rewritten to `0..n-1`.
 */
export async function reorderStarredFolders(db: Db, list: unknown): Promise<ReorderFoldersResult> {
  if (!Array.isArray(list) || !list.every(isId)) {
    return { ok: false, status: 400, error: "folderIds: must be a list of folder ids" };
  }
  const wanted = list as number[];
  if (new Set(wanted).size !== wanted.length) {
    return { ok: false, status: 400, error: "folderIds: a folder is listed twice" };
  }
  return db.transaction(async (tx): Promise<ReorderFoldersResult> => {
    const all = await tx
      .select({ id: repoFolders.id, starPosition: repoFolders.starPosition })
      .from(repoFolders)
      .for("update");
    const byId = new Map(all.map((f) => [f.id, f]));
    if (wanted.some((id) => !byId.has(id))) {
      return { ok: false, status: 400, error: "folderIds: unknown folder" };
    }
    const starred = all.filter((f) => f.starPosition !== null).length;
    if (wanted.length !== starred || wanted.some((id) => byId.get(id)?.starPosition === null)) {
      return { ok: false, status: 409, error: "The starred list changed; reload and try again" };
    }
    for (const [position, id] of wanted.entries()) {
      await tx.update(repoFolders).set({ starPosition: position }).where(eq(repoFolders.id, id));
    }
    return { ok: true, folderIds: wanted };
  });
}
