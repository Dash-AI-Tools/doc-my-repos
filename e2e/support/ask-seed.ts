import { eq } from "drizzle-orm";

import type { Db } from "../../src/server/db/client";
import { repos } from "../../src/server/db/schema";
import { persistRepoSync } from "../../src/server/sync/persist";
import { ASK_REPO } from "./ask-data";
import { metadata, planFor } from "./seed";

/** Adds the Ask e2e repository through the real persistence path, like `seedDatabase`. */
export async function seedAskData(db: Db): Promise<void> {
  const result = await persistRepoSync(db, { repo: metadata(ASK_REPO), plan: planFor(ASK_REPO) });
  if (!result.complete) throw new Error("Seeding the Ask e2e repository was incomplete");
  if (ASK_REPO.lastSyncedAt !== undefined) {
    await db
      .update(repos)
      .set({ lastSyncedAt: new Date(ASK_REPO.lastSyncedAt) })
      .where(eq(repos.githubId, ASK_REPO.githubId));
  }
}
