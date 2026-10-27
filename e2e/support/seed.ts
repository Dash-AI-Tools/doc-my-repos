import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import type { Db } from "../../packages/server/src/db/client";
import { repos, syncRuns, type SyncRepoResult } from "../../packages/server/src/db/schema";
import {
  persistRepoSync,
  type PersistFetchedDoc,
  type PersistPlan,
  type PersistRepo,
} from "../../packages/server/src/sync/persist";
import { SEED_REPOS, SEED_RUNS, type SeedRepo } from "./seed-data";

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
 *
 * Two `sync_runs` rows (`SEED_RUNS`) give `/status` and the repository headers a last run (task
 * 12.2). Their `results` entries have the shape the run recorder writes.
 */

function sha(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

export function metadata(repo: SeedRepo): PersistRepo {
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

export function planFor(repo: SeedRepo): PersistPlan {
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
    ...((repo.apiSpecs?.length ?? 0) > 0
      ? {
          apiSpecs: {
            fetched: (repo.apiSpecs ?? []).map((d) => fetchedDoc(d.path, d.text)),
            removed: [],
            failed: [],
            skipped: [],
            missing: [],
          },
        }
      : {}),
    ...(repo.selection === undefined
      ? {}
      : { selection: { skipped: repo.selection.skipped, capped: repo.selection.capped } }),
  };
}

function runEntry(repo: SeedRepo, extra: Partial<SyncRepoResult>): SyncRepoResult {
  return {
    repo: `${repo.owner}/${repo.name}`,
    githubId: repo.githubId,
    status: "ok",
    error: null,
    errorKind: null,
    retryable: false,
    retryAfter: null,
    added: 0,
    updated: 0,
    identical: 0,
    removed: 0,
    skipped: 0,
    skippedFiles: [],
    failedFiles: [],
    failedFilesTotal: 0,
    warnings: [],
    warningsTotal: 0,
    replacedRepos: [],
    ...extra,
  };
}

/** Per-repo entry of the successful run: every stored document added; skips for capped-docs. */
function successEntry(repo: SeedRepo): SyncRepoResult {
  const skipped = repo.selection?.skipped ?? [];
  return runEntry(repo, {
    added: repo.docs?.length ?? 0,
    skipped: skipped.length,
    skippedFiles: skipped.slice(0, 50).map((s) => ({ path: s.path, reason: s.reason })),
    warnings: repo.selection?.capped
      ? [
          {
            path: null,
            message: `document limit reached: ${repo.selection.capped.found} docs files found, only the first ${repo.selection.capped.limit} synced`,
          },
        ]
      : [],
    warningsTotal: repo.selection?.capped ? 1 : 0,
  });
}

async function seedRuns(db: Db): Promise<void> {
  const synced = SEED_REPOS.filter((r) => r.state !== "pending");
  await db.insert(syncRuns).values([
    {
      ...SEED_RUNS.success,
      scope: null,
      startedAt: new Date(SEED_RUNS.success.startedAt),
      finishedAt: new Date(SEED_RUNS.success.finishedAt),
      results: synced.map(successEntry),
    },
    {
      ...SEED_RUNS.partial,
      scope: null,
      startedAt: new Date(SEED_RUNS.partial.startedAt),
      finishedAt: new Date(SEED_RUNS.partial.finishedAt),
      results: synced.map((repo) =>
        repo.state === "error"
          ? runEntry(repo, {
              status: "error",
              error: repo.syncError ?? "GitHub request failed",
              errorKind: "rate_limited",
              retryable: true,
            })
          : runEntry(repo, { status: "unchanged" }),
      ),
    },
  ]);
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
  await seedRuns(db);
}
