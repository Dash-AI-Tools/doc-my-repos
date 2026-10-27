import type { Db } from "../../packages/server/src/db/client";
import { documents, repos } from "../../packages/server/src/db/schema";

/**
 * Data for the MCP e2e stacks (`agent` and `agentoff`), on top of the shared seed and the comment
 * users: one OKF repository that has an `okf-guidelines.md`, so a spec can read the file for it and
 * the generated draft for any seeded repository that has none. Written straight into the tables,
 * as the sync would store it.
 */

export const AGENT_REPO = { owner: "acme", name: "agent-guidelines" } as const;
export const AGENT_GUIDELINES_PATH = "docs/okf-guidelines.md";
export const AGENT_RUNBOOK_PATH = "docs/runbooks/restore-backups.md";
export const AGENT_RUNBOOK_QUERY = "restore database backups";

export async function seedAgentData(db: Db): Promise<void> {
  const [repo] = await db
    .insert(repos)
    .values({
      githubId: 880_001,
      owner: AGENT_REPO.owner,
      name: AGENT_REPO.name,
      visibility: "public",
      defaultBranch: "main",
      htmlUrl: `https://github.com/${AGENT_REPO.owner}/${AGENT_REPO.name}`,
      description: "A repository with its own OKF guidelines",
      docsPath: "docs",
      isOkf: true,
      okfVersion: "0.2",
      syncStatus: "ok",
      lastSyncedAt: new Date("2026-10-15T08:00:00Z"),
    })
    .returning({ id: repos.id });
  const repoId = repo!.id;
  const row = (path: string, title: string, extra: Partial<typeof documents.$inferInsert>) => ({
    repoId,
    path,
    title,
    blobSha: `sha-${path}`,
    sizeBytes: 100,
    body: `# ${title}\n\nBody of ${path}.`,
    ...extra,
  });
  await db.insert(documents).values([
    row("docs/index.md", "Overview", { reserved: "index", description: "Start here" }),
    row(AGENT_GUIDELINES_PATH, "House rules for documents", {
      description: "How we write documentation",
      type: "Guidelines",
      tags: ["guidelines"],
      status: "stable",
      body: "# House rules for documents\n\nEvery document has a type. Reuse `Runbook` for procedures.\n",
      frontmatter: { type: "Guidelines" },
    }),
    row(AGENT_RUNBOOK_PATH, "Restore database backups", {
      description: "Restore the production database from a backup",
      type: "Runbook",
      tags: ["ops", "database"],
      status: "stable",
      body: "# Restore database backups\n\nStop the app, then restore the database backups from the latest dump.\n",
      headings: [{ depth: 1, text: "Restore database backups", slug: "restore-database-backups" }],
      frontmatter: { type: "Runbook", tags: ["ops", "database"] },
    }),
  ]);
}
