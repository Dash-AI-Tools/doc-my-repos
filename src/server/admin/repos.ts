import { eq } from "drizzle-orm";

import type { Db } from "@/server/db/client";
import { repos } from "@/server/db/schema";

export type SetAllowedResult =
  | { ok: true; owner: string; name: string; isAllowed: boolean }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Admin allow/block toggle. Content is kept; the visibility chokepoint hides blocked repos from
 * every read, and re-allowing restores them without re-syncing. Owner/name match
 * case-insensitively, like the read layer; the repos table is small (one row per repo) and this
 * is an admin-only action, so a single scan is enough.
 */
export async function setRepoAllowed(
  db: Db,
  owner: unknown,
  name: unknown,
  isAllowed: unknown,
): Promise<SetAllowedResult> {
  if (
    typeof owner !== "string" ||
    owner.trim() === "" ||
    typeof name !== "string" ||
    name.trim() === ""
  ) {
    return { ok: false, status: 400, error: "owner and name are required" };
  }
  if (typeof isAllowed !== "boolean") {
    return { ok: false, status: 400, error: "isAllowed: must be a boolean" };
  }
  const wantedOwner = owner.trim().toLowerCase();
  const wantedName = name.trim().toLowerCase();
  const all = await db.select({ id: repos.id, owner: repos.owner, name: repos.name }).from(repos);
  const target = all.find(
    (r) => r.owner.toLowerCase() === wantedOwner && r.name.toLowerCase() === wantedName,
  );
  if (!target) return { ok: false, status: 404, error: "repo not found" };
  await db.update(repos).set({ isAllowed, updatedAt: new Date() }).where(eq(repos.id, target.id));
  return { ok: true, owner: target.owner, name: target.name, isAllowed };
}
