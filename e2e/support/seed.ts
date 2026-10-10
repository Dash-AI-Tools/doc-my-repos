import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import type { Db } from "../../src/server/db/client";
import { repos } from "../../src/server/db/schema";
import {
  persistRepoSync,
  type PersistFetchedDoc,
  type PersistPlan,
  type PersistRepo,
} from "../../src/server/sync/persist";
import { SEED_REPOS, type SeedRepo } from "./seed-data";

/**
 * Writes `SEED_REPOS` into a migrated database through the real persistence path
 * (`persistRepoSync`, the same code a sync uses), so the stored rows have exactly the shape the
 * pages read: parsed documents, headings, generated search vector, OKF detection, code owners.
 * Handcrafted plans stand in for GitHub; nothing here talks to the network.
 *
 * Two things persistence deliberately leaves to other code are done directly here: the failed
 * state of `flaky-service` (`sync_status`/`sync_error`, written by the run recorder after a
 * failure) and `pending` repositories (a repository row that no sync has completed). Both are
 * written with the values the sync writes.
 */

function sha(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

function metadata(repo: SeedRepo): PersistRepo {
  return {
    githubId: repo.githubId,
    owner: repo.owner,
    name: repo.name,
    description: repo.description,
    defaultBranch: "main",
    archived: false,
    visibility: repo.visibility,
    htmlUrl: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

function fetchedDoc(path: string, text: string): PersistFetchedDoc {
  return { path, blobSha: sha(`${path}\n${text}`), size: Buffer.byteLength(text), text };
}

function planFor(repo: SeedRepo): PersistPlan {
  const file = (path: string, text: string) => ({
    state: "fetched" as const,
    file: { path, blobSha: sha(`${path}\n${text}`), size: Buffer.byteLength(text) },
    text,
    warnings: [],
  });
  return {
    kind: "content",
    treeSha: sha(`tree ${repo.githubId}`),
    commitSha: sha(`commit ${repo.githubId}`),
    headEtag: `W/"e2e-${repo.githubId}"`,
    selectionFingerprint: "v1:e2e",
    docsFolder: (repo.docs?.length ?? 0) > 0 ? (repo.docsFolder ?? "docs") : null,
    fetched: (repo.docs ?? []).map((d) => fetchedDoc(d.path, d.text)),
    removed: [],
    failed: [],
    readme: repo.readme === undefined ? { state: "absent" } : file("README.md", repo.readme),
    codeowners:
      repo.codeowners === undefined
        ? { state: "absent" }
        : file(".github/CODEOWNERS", repo.codeowners),
  };
}

export async function seedDatabase(db: Db): Promise<void> {
  for (const repo of SEED_REPOS) {
    if (repo.state === "pending") {
      const meta = metadata(repo);
      await db.insert(repos).values({
        githubId: meta.githubId,
        owner: meta.owner,
        name: meta.name,
        description: meta.description,
        defaultBranch: meta.defaultBranch,
        visibility: repo.visibility,
        htmlUrl: meta.htmlUrl,
      });
      continue;
    }

    const result = await persistRepoSync(db, { repo: metadata(repo), plan: planFor(repo) });
    if (!result.complete) {
      throw new Error(`Seeding ${repo.owner}/${repo.name} was incomplete`);
    }

    const update: Partial<typeof repos.$inferInsert> = {};
    if (repo.lastSyncedAt !== undefined) update.lastSyncedAt = new Date(repo.lastSyncedAt);
    if (repo.state === "error") {
      update.syncStatus = "error";
      update.syncError = repo.syncError ?? "GitHub request failed";
    }
    if (Object.keys(update).length > 0) {
      await db.update(repos).set(update).where(eq(repos.githubId, repo.githubId));
    }
  }
}
