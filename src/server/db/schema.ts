import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
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
export const userRole = pgEnum("user_role", ["admin", "user"]);

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// Postgres tsvector, read as its text form. Only used for the generated search column.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * Text-search configuration baked into documents.search_vector. Language-neutral: no
 * stemming or stop words, so docs in any language match. Search queries (task 10.1) must
 * call websearch_to_tsquery with this same regconfig, or lexemes will not line up.
 * Changing it requires a new migration that recomputes the column.
 */
export const SEARCH_TEXT_CONFIG = "simple";

const searchConfig = sql.raw(`'${SEARCH_TEXT_CONFIG}'::regconfig`);

// Weights: title A, headings B, description and tags C, body D. Every input is coalesced
// so a null column never nulls out the whole vector. Only the `text` of each heading is
// indexed (not `slug` or `depth`). Tags go through an IMMUTABLE text[]-only wrapper
// (migration 0001) because array_to_string itself is STABLE and is rejected here.
const searchVectorExpression = sql`setweight(to_tsvector(${searchConfig}, coalesce("title", '')), 'A') || setweight(jsonb_to_tsvector(${searchConfig}, jsonb_path_query_array(coalesce("headings", '[]'::jsonb), '$[*].text'), '["string"]'::jsonb), 'B') || setweight(to_tsvector(${searchConfig}, coalesce("description", '')), 'C') || setweight(to_tsvector(${searchConfig}, coalesce(public.docmyrepos_immutable_array_to_string("tags", ' '), '')), 'C') || setweight(to_tsvector(${searchConfig}, coalesce("body", '')), 'D')`;

export type Heading = { depth: number; text: string; slug: string };
export type CodeOwnerRef = { handle: string; kind: (typeof codeOwnerKinds)[number] };
export type SyncWarning = { path: string | null; message: string };
/**
 * Why some files of a repository are not shown (task 12.3, `src/server/sync/warnings.ts`), kept on
 * `repos.sync_warnings` so pages can show it without reading `sync_runs`. `count` is the number of
 * files concerned; `paths` lists at most the first 20 of them (repo-relative, in path order).
 * Messages are fixed texts plus numbers, never file contents.
 */
export type RepoSyncWarning = {
  code: "docs_capped" | "too_large" | "size_unknown" | "write_rejected" | "unsupported";
  message: string;
  count: number;
  paths: string[];
};
/**
 * One repository's outcome in `sync_runs.results` (task 5.7, `src/server/sync/runs.ts`). Lists are
 * capped; the `*Total` fields keep the real counts. Messages are fixed texts, never raw errors.
 */
/**
 * Why a stored repo is deleted (task 5.9, `src/server/sync/removal.ts`).
 * - `not_in_installation`: absent from a complete installation listing (removed from the
 *   installation, deleted on GitHub, or a config-listed repo the App cannot access).
 * - `dropped_from_config`: still accessible, but no longer in the config's `repos` list.
 * - `excluded`: accessible, but now in the config's `exclude` list.
 * - `archived`: archived upstream; only non-archived repos are synced and shown.
 * - `deleted`: GitHub reported the repository deleted (webhook, task 6.3).
 */
export type RepoRemovalReason =
  "not_in_installation" | "dropped_from_config" | "excluded" | "archived" | "deleted";

export type SyncRepoResult = {
  /** "owner/name" at the time of the run. */
  repo: string;
  githubId: number;
  /**
   * `skipped`: not attempted (another sync held the repo, or the run stopped on a fatal error).
   * `removed`: the repo row and its documents and code owners were deleted (task 5.9); `removed`
   * then counts the deleted documents.
   */
  status: "ok" | "error" | "unchanged" | "skipped" | "removed";
  /** Why the repo was (or is due to be) removed; set only on removal entries (task 5.9). */
  removalReason?: RepoRemovalReason;
  error: string | null;
  /** Stable error kind (a GitHubError/PersistError/RepoSyncError kind), null when ok. */
  errorKind: string | null;
  /** True when the same sync is expected to succeed later without a change upstream. */
  retryable: boolean;
  /** ISO time after which a rate-limited request can be retried, when GitHub said so. */
  retryAfter: string | null;
  added: number;
  updated: number;
  identical: number;
  removed: number;
  /** Documents skipped (persist skips plus tree-selection skips). */
  skipped: number;
  skippedFiles: { path: string; reason: string }[];
  /** Paths kept as stored because their fetch failed. */
  failedFiles: string[];
  failedFilesTotal: number;
  warnings: SyncWarning[];
  warningsTotal: number;
  /** Stale rows replaced because they held this repo's owner/name ("owner/name"). */
  replacedRepos: string[];
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
    // Hash of the doc selection settings (task 5.4). Stored with tree_sha after a fully
    // successful sync only; the tree short-circuit needs both to match.
    selectionFingerprint: text("selection_fingerprint"),
    // ETag and commit SHA of the default-branch head response, stored with tree_sha, so the next
    // sync can send a conditional request (a 304 costs no rate limit).
    headEtag: text("head_etag"),
    commitSha: text("commit_sha"),
    docsPath: text("docs_path"),
    isOkf: boolean("is_okf").notNull().default(false),
    okfVersion: text("okf_version"),
    syncStatus: repoSyncStatus("sync_status").notNull().default("pending"),
    syncError: text("sync_error"),
    lastSyncedAt: timestamptz("last_synced_at"),
    // Files the last content sync left out (document cap, size cap, rejected), task 12.3. Written
    // by every content persist (empty when nothing was left out); a failed sync keeps it.
    syncWarnings: jsonb("sync_warnings")
      .$type<RepoSyncWarning[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Rerun marker (task 6.4, `src/server/sync/requests.ts`): when a sync of this repo was last
    // requested and not yet covered by a finished pass. Survives across processes and crashes.
    // Never a portal field and never a `sync_runs` status.
    syncRequestedAt: timestamptz("sync_requested_at"),
    // Admin allow/block toggle (access-control): blocked repos keep content but are hidden
    // everywhere via the visibility chokepoint. Default true so existing rows stay visible.
    isAllowed: boolean("is_allowed").notNull().default(true),
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
    // Computed by Postgres (GENERATED ALWAYS ... STORED); Drizzle omits it from insert and
    // update types, and Postgres rejects explicit writes. Select it only for search.
    searchVector: tsvector("search_vector").notNull().generatedAlwaysAs(searchVectorExpression),
  },
  (t) => [
    unique("documents_repo_id_path_unique").on(t.repoId, t.path),
    index("documents_search_vector_idx").using("gin", t.searchVector),
    index("documents_repo_id_type_idx").on(t.repoId, t.type),
  ],
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

export const users = pgTable(
  "users",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull().default("user"),
    disabled: boolean("disabled").notNull().default(false),
    // Bumped on password reset/disable so outstanding cookies stop working.
    pwVersion: integer("pw_version").notNull().default(0),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("users_email_unique").on(t.email)],
);
