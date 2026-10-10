import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const repoVisibility = pgEnum("repo_visibility", ["public", "private"]);
export const repoSyncStatus = pgEnum("repo_sync_status", ["pending", "ok", "error"]);
export const documentReserved = pgEnum("document_reserved", ["index", "log"]);
export const codeOwnerKinds = ["user", "team", "email"] as const;
export const syncTrigger = pgEnum("sync_trigger", ["webhook", "manual", "schedule", "startup"]);
export const syncRunStatus = pgEnum("sync_run_status", ["running", "success", "partial", "failed"]);

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export type Heading = { depth: number; text: string; slug: string };
export type CodeOwnerRef = { handle: string; kind: (typeof codeOwnerKinds)[number] };
export type SyncWarning = { path: string | null; message: string };
export type SyncRepoResult = {
  repo: string;
  status: "ok" | "error" | "unchanged";
  error: string | null;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  warnings: SyncWarning[];
};

export const repos = pgTable(
  "repos",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    githubId: bigint("github_id", { mode: "number" }).notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    defaultBranch: text("default_branch").notNull(),
    archived: boolean("archived").notNull().default(false),
    visibility: repoVisibility("visibility").notNull(),
    htmlUrl: text("html_url").notNull(),
    readmePath: text("readme_path"),
    readmeMarkdown: text("readme_markdown"),
    readmeSha: text("readme_sha"),
    // CODEOWNERS blob SHA lives here, not on code_owners: a repo with zero rules has no row.
    codeownersPath: text("codeowners_path"),
    codeownersSha: text("codeowners_sha"),
    treeSha: text("tree_sha"),
    docsPath: text("docs_path"),
    isOkf: boolean("is_okf").notNull().default(false),
    okfVersion: text("okf_version"),
    syncStatus: repoSyncStatus("sync_status").notNull().default("pending"),
    syncError: text("sync_error"),
    lastSyncedAt: timestamptz("last_synced_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("repos_owner_name_unique").on(t.owner, t.name),
    unique("repos_github_id_unique").on(t.githubId),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    blobSha: text("blob_sha").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    // Free-form and case-preserved: no enum, no normalization.
    type: text("type"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text("status"),
    headings: jsonb("headings")
      .$type<Heading[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Full frontmatter as authored, unknown keys included.
    frontmatter: jsonb("frontmatter")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    body: text("body").notNull(),
    reserved: documentReserved("reserved"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("documents_repo_id_path_unique").on(t.repoId, t.path)],
);

export const codeOwners = pgTable(
  "code_owners",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    // Position of the rule in the CODEOWNERS file; order is meaningful.
    position: integer("position").notNull(),
    pattern: text("pattern").notNull(),
    owners: jsonb("owners").$type<CodeOwnerRef[]>().notNull(),
    sourcePath: text("source_path").notNull(),
  },
  (t) => [unique("code_owners_repo_id_position_unique").on(t.repoId, t.position)],
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    trigger: syncTrigger("trigger").notNull(),
    // "owner/name" when the run targeted one repository, null for a full run.
    scope: text("scope"),
    status: syncRunStatus("status").notNull().default("running"),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    finishedAt: timestamptz("finished_at"),
    reposTotal: integer("repos_total").notNull().default(0),
    reposSynced: integer("repos_synced").notNull().default(0),
    reposUnchanged: integer("repos_unchanged").notNull().default(0),
    reposFailed: integer("repos_failed").notNull().default(0),
    docsAdded: integer("docs_added").notNull().default(0),
    docsUpdated: integer("docs_updated").notNull().default(0),
    docsRemoved: integer("docs_removed").notNull().default(0),
    docsSkipped: integer("docs_skipped").notNull().default(0),
    results: jsonb("results")
      .$type<SyncRepoResult[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    error: text("error"),
  },
  (t) => [index("sync_runs_started_at_idx").on(t.startedAt)],
);
