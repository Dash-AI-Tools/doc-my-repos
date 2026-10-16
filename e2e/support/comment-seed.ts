import { createHash } from "node:crypto";

import type { Db } from "../../src/server/db/client";
import { createDb } from "../../src/server/db/client";
import { docComments, users } from "../../src/server/db/schema";
import { persistRepoSync } from "../../src/server/sync/persist";
import {
  COMMENT_DOCS,
  COMMENT_USERS,
  HEAVY_THREADS,
  ORPHANS,
  type CommentUser,
} from "./comment-data";
import { metadata, planFor } from "./seed";
import { SEED_REPOS } from "./seed-data";
import { databaseUrl } from "./stack";

/**
 * Writes the users and comments of the comments e2e data (`comment-data.ts`) into a seeded
 * database, and removes and restores a document the way a sync does (`persistRepoSync`).
 */

const HOUR = 3_600_000;

export async function seedCommentData(db: Db): Promise<void> {
  const rows = await db
    .insert(users)
    .values(
      (Object.keys(COMMENT_USERS) as CommentUser[]).map((key) => ({
        email: COMMENT_USERS[key].email,
        // Never a real hash: nobody signs in with these users, the header selects them.
        passwordHash: "e2e-not-a-password-hash",
        role: COMMENT_USERS[key].role,
      })),
    )
    .returning({ id: users.id, email: users.email });
  const id = (key: CommentUser): number => {
    const row = rows.find((r) => r.email === COMMENT_USERS[key].email);
    if (!row) throw new Error(`seed user ${key} missing`);
    return row.id;
  };
  const label = (key: CommentUser) => COMMENT_USERS[key].email.split("@")[0]!;
  const now = Date.now();
  const ago = (hours: number) => new Date(now - hours * HOUR);

  const base = (doc: { githubId: number; path: string }) => ({
    githubRepoId: doc.githubId,
    path: doc.path,
  });
  const by = (key: CommentUser) => ({ authorId: id(key), authorLabel: label(key) });

  // Heavy document: HEAVY_THREADS threads, long names, unbroken words, replies, resolved threads,
  // a deleted root with a reply, and organization comments.
  const authors: CommentUser[] = ["ana", "long", "ben", "long", "rita"];
  const longWord = "W".repeat(400);
  const roots = await db
    .insert(docComments)
    .values(
      Array.from({ length: HEAVY_THREADS }, (_, i) => {
        const author = authors[i % authors.length]!;
        const deleted = i === 4;
        return {
          ...base(COMMENT_DOCS.heavy),
          ...by(author),
          body: deleted
            ? ""
            : i % 7 === 0
              ? `Unbroken word ${longWord}`
              : i % 5 === 0
                ? `Line one of thread ${i}.\n\nLine two with a link https://example.com/${"p".repeat(120)}`
                : `Thread ${i}: a question about this endpoint.`,
          createdAt: ago(HEAVY_THREADS - i + 24),
          deletedAt: deleted ? ago(1) : null,
          resolvedAt: i % 10 === 9 ? ago(2) : null,
          resolvedBy: i % 10 === 9 ? id("olga") : null,
        };
      }),
    )
    .returning({ id: docComments.id, createdAt: docComments.createdAt });
  const ordered = [...roots].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  await db.insert(docComments).values(
    ordered.flatMap((root, i) => {
      if (i % 3 !== 0 && i !== 4) return [];
      const asOrg = i % 6 === 0;
      return [
        {
          ...base(COMMENT_DOCS.heavy),
          ...by(asOrg ? "olga" : "ben"),
          asOrg,
          parentId: root.id,
          body: asOrg ? "The organization answers here." : `Reply ${i}: ${longWord.slice(0, 80)}`,
          createdAt: new Date(root.createdAt.getTime() + HOUR / 2),
        },
      ];
    }),
  );

  // Blocked-repository document.
  await db.insert(docComments).values([
    {
      ...base(COMMENT_DOCS.blocked),
      ...by("ana"),
      body: "Blocked-repo comment one.",
      createdAt: ago(5),
    },
    {
      ...base(COMMENT_DOCS.blocked),
      ...by("ben"),
      body: "Blocked-repo comment two.",
      createdAt: ago(4),
    },
  ]);

  // Synced document: a root and its reply.
  const [syncRoot] = await db
    .insert(docComments)
    .values({
      ...base(COMMENT_DOCS.synced),
      ...by("ana"),
      body: "Synced root comment.",
      createdAt: ago(6),
    })
    .returning({ id: docComments.id });
  await db.insert(docComments).values({
    ...base(COMMENT_DOCS.synced),
    ...by("ben"),
    parentId: syncRoot!.id,
    body: "Synced reply comment.",
    createdAt: ago(5),
  });

  // Orphans: a document that is gone, and a repository that is gone. The layout specs have a
  // document of their own that no spec removes.
  await db.insert(docComments).values([
    ...Array.from({ length: ORPHANS.layout.count }, (_, i) => ({
      ...base(ORPHANS.layout),
      ...by("long"),
      body: `Orphan kept for the layout checks ${i + 1}. ${longWord.slice(0, 120)}`,
      createdAt: ago(20 + i),
    })),
    ...Array.from({ length: ORPHANS.document.count }, (_, i) => ({
      ...base(ORPHANS.document),
      ...by("ana"),
      body: `Orphan of a removed document ${i + 1}.`,
      createdAt: ago(30 + i),
    })),
    ...Array.from({ length: ORPHANS.repository.count }, (_, i) => ({
      ...base(ORPHANS.repository),
      ...by("ben"),
      body: `Orphan of a removed repository ${i + 1}.`,
      createdAt: ago(40 + i),
    })),
  ]);
}

function seedRepoFor(doc: { owner: string; name: string }) {
  const repo = SEED_REPOS.find((r) => r.owner === doc.owner && r.name === doc.name);
  if (!repo) throw new Error(`${doc.owner}/${doc.name} is not seeded`);
  return repo;
}

/** A sync of the `comments` database in which `path` disappeared from the repository, or came back. */
export async function syncDocument(
  doc: { owner: string; name: string; path: string },
  change: "remove" | "restore",
): Promise<void> {
  const repo = seedRepoFor(doc);
  const handle = createDb(databaseUrl("comments"), { max: 1, connectTimeoutMs: 5_000 });
  try {
    const plan = planFor(repo);
    if (plan.kind !== "content") throw new Error("expected a content plan");
    const stored = plan.fetched.find((d) => d.path === doc.path);
    if (!stored) throw new Error(`${doc.path} is not a seeded document`);
    const sha = createHash("sha1").update(`${change} ${doc.path}`).digest("hex");
    const result = await persistRepoSync(handle.db, {
      repo: metadata(repo),
      plan: {
        ...plan,
        treeSha: sha,
        fetched: change === "restore" ? [stored] : [],
        removed: change === "remove" ? [{ path: doc.path }] : [],
      },
    });
    if (!result.complete) throw new Error("sync was incomplete");
  } finally {
    await handle.close();
  }
}
