import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
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
 * Why some files of a repository are not shown (task 12.3, `packages/server/src/sync/warnings.ts`), kept on
 * `repos.sync_warnings` so pages can show it without reading `sync_runs`. `count` is the number of
 * files concerned; `paths` lists at most the first 20 of them (repo-relative, in path order).
 * Messages are fixed texts plus numbers, never file contents.
 */
export type RepoSyncWarning = {
  code:
    | "docs_capped"
    | "too_large"
    | "size_unknown"
    | "write_rejected"
    | "unsupported"
    // OpenAPI/Swagger spec files (openapi-reference): the same idea, apart from documents.
    | "api_spec_invalid"
    | "api_spec_too_large"
    | "api_spec_over_limit"
    | "api_spec_missing"
    | "api_spec_unsupported";
  message: string;
  count: number;
  paths: string[];
};
/**
 * One repository's outcome in `sync_runs.results` (task 5.7, `packages/server/src/sync/runs.ts`). Lists are
 * capped; the `*Total` fields keep the real counts. Messages are fixed texts, never raw errors.
 */
/**
 * Why a stored repo is deleted (task 5.9, `packages/server/src/sync/removal.ts`).
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

/**
 * Admin-managed folders that group repositories on the home page (repo-folders). Optional: no row
 * exists until an admin creates one. `star_position` follows the same scheme as
 * `repos.star_position` (null = not starred, otherwise the place in the tab order). Names are
 * unique ignoring case.
 */
export const repoFolders = pgTable(
  "repo_folders",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    description: text("description"),
    starPosition: integer("star_position"),
    // Public access (public-access): every allowed repository in a public folder is readable
    // without signing in. Written only by the admin folder actions, never by sync.
    isPublic: boolean("is_public").notNull().default(false),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("repo_folders_name_lower_unique").on(sql`lower(${t.name})`)],
);

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
    // Rerun marker (task 6.4, `packages/server/src/sync/requests.ts`): when a sync of this repo was last
    // requested and not yet covered by a finished pass. Survives across processes and crashes.
    // Never a portal field and never a `sync_runs` status.
    syncRequestedAt: timestamptz("sync_requested_at"),
    // Admin allow/block toggle (access-control): blocked repos keep content but are hidden
    // everywhere via the visibility chokepoint. Default true so existing rows stay visible.
    isAllowed: boolean("is_allowed").notNull().default(true),
    // Admin-curated, portal-wide star: null = not starred, otherwise the place in the starred
    // order. Written only by star/unstar/reorder (never by the sync's explicit-column upsert), so
    // blocking and syncing keep it. Not unique or contiguous: reads order by it then id.
    starPosition: integer("star_position"),
    // Admin-chosen folder (repo-folders); null = in no folder. Written only by the admin folder
    // actions (never by the sync's explicit-column upsert). Deleting a folder clears it.
    folderId: integer("folder_id").references(() => repoFolders.id, { onDelete: "set null" }),
    // Public access (public-access): readable without signing in, on top of `is_allowed`. Not the
    // GitHub `visibility` above. Written only by the admin repo action, never by sync.
    isPublic: boolean("is_public").notNull().default(false),
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

/**
 * Parsed OpenAPI/Swagger specs (openapi-reference design decision 1). Kept out of `documents` so
 * they never enter search, the docs tree, doc counts or OKF detection. `spec` is the parsed
 * document (strings cleaned like documents, `toDbJson`), rendered at read time.
 */
export const apiSpecs = pgTable(
  "api_specs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    blobSha: text("blob_sha").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    format: text("format").$type<"openapi" | "swagger">().notNull(),
    specVersion: text("spec_version").notNull(),
    title: text("title").notNull(),
    apiVersion: text("api_version"),
    operationCount: integer("operation_count").notNull(),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("api_specs_repo_id_path_unique").on(t.repoId, t.path),
    check("api_specs_format", sql`${t.format} IN ('openapi', 'swagger')`),
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
    // Set when an administrator resets the password: API tokens created before it stop working
    // (mcp-agent-access design decision 2). Null until then.
    tokensValidAfter: timestamptz("tokens_valid_after"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("users_email_unique").on(t.email)],
);

/**
 * Personal API tokens for the MCP endpoint (mcp-agent-access design decision 2). Only the SHA-256
 * hash of the token and its first characters (`prefix`, for display) are stored: the full token is
 * shown once at creation. A token acts as its user, so it is removed with the user. Revoked and
 * expired rows are kept 30 days for the list, then deleted when a token is created.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    revokedAt: timestamptz("revoked_at"),
    lastUsedAt: timestamptz("last_used_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("api_tokens_token_hash_unique").on(t.tokenHash),
    index("api_tokens_user_idx").on(t.userId),
    check("api_tokens_name_length", sql`char_length(${t.name}) between 1 and 60`),
  ],
);

/** Raw bytes for the branding logo (`bytea`, at most 512 KB by API validation). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Portal branding (org-branding 2.1): one row (`id` fixed to 1), null means default.
 * The logo bytes live here; `getBranding` never selects them (see decision 1).
 */
export const siteBranding = pgTable(
  "site_branding",
  {
    id: smallint("id").primaryKey(),
    orgName: text("org_name"),
    pageTitle: text("page_title"),
    primaryColor: text("primary_color"),
    accentColor: text("accent_color"),
    coloredHeader: boolean("colored_header").notNull().default(false),
    invertLogoOnDark: boolean("invert_logo_on_dark").notNull().default(true),
    logo: bytea("logo"),
    logoType: text("logo_type"),
    logoVersion: integer("logo_version").notNull().default(0),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [check("site_branding_single_row", sql`${t.id} = 1`)],
);

/**
 * Document comments (document-comments design decision 1). Keyed by the GitHub repository id and
 * the document path, with deliberately NO foreign key to `repos` or `documents`: removal and sync
 * delete those rows, and a re-added repository comes back with a new `repos.id`, so a cascade would
 * destroy comments that must survive. Reads go through the query layer (visibility filter); the
 * author's name is a snapshot (`author_label`) so removing a user does not rewrite history.
 */
export const docComments = pgTable(
  "doc_comments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
    path: text("path").notNull(),
    // A reply points at its thread root; deleting a root (moderation) deletes its replies.
    parentId: bigint("parent_id", { mode: "number" }).references(
      (): AnyPgColumn => docComments.id,
      { onDelete: "cascade" },
    ),
    authorId: integer("author_id").references(() => users.id, { onDelete: "set null" }),
    authorLabel: text("author_label").notNull(),
    asOrg: boolean("as_org").notNull().default(false),
    body: text("body").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    editedAt: timestamptz("edited_at"),
    deletedAt: timestamptz("deleted_at"),
    deletedByAdmin: boolean("deleted_by_admin").notNull().default(false),
    resolvedAt: timestamptz("resolved_at"),
    resolvedBy: integer("resolved_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("doc_comments_doc_created_idx").on(t.githubRepoId, t.path, t.createdAt),
    index("doc_comments_created_idx").on(t.createdAt.desc()),
    check("doc_comments_reply_not_resolved", sql`${t.parentId} IS NULL OR ${t.resolvedAt} IS NULL`),
    check("doc_comments_body_length", sql`char_length(${t.body}) <= 4000`),
  ],
);

/**
 * Public access settings (public-access design decision 4): one row (`id` fixed to 1), edited by an
 * admin. No row means the defaults: anonymous search on, anonymous Ask off, 200 questions a day
 * and 20 per ten minutes shared by all anonymous visitors. Kept out of the workspace settings
 * document on purpose: that schema is strict, so an older image would reject an unknown key.
 */
export const publicAccessSettings = pgTable(
  "public_access_settings",
  {
    id: smallint("id").primaryKey(),
    searchEnabled: boolean("search_enabled").notNull().default(true),
    askEnabled: boolean("ask_enabled").notNull().default(false),
    askQuestionsPerDay: integer("ask_questions_per_day").notNull().default(200),
    askQuestionsPerTenMinutes: integer("ask_questions_per_ten_minutes").notNull().default(20),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [check("public_access_settings_single_row", sql`${t.id} = 1`)],
);

/**
 * Ask-the-docs settings (ask-the-docs design decision 9): one row (`id` fixed to 1), edited by an
 * admin. Credentials are never stored here; `provider` and `model` are re-validated on read.
 */
export const askSettings = pgTable(
  "ask_settings",
  {
    id: smallint("id").primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    provider: text("provider"),
    model: text("model"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [check("ask_settings_single_row", sql`${t.id} = 1`)],
);

/**
 * One row per question accepted for the model (ask-the-docs design decision 7). Counts and an
 * outcome only: there is deliberately no column that could hold a question, an answer or an
 * excerpt. Rows older than 90 days are deleted opportunistically.
 */
export const askUsage = pgTable(
  "ask_usage",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    provider: text("provider").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    excerptCount: integer("excerpt_count").notNull().default(0),
    // `started` until the answer ends; then a fixed outcome word (see packages/server/src/ask/limits.ts).
    outcome: text("outcome").notNull().default("started"),
    // True for a question asked without signing in (public Ask): `user_id` is null, and this tells
    // it apart from the rows of deleted users, which are null too. Counted only as totals.
    anonymous: boolean("anonymous").notNull().default(false),
  },
  (t) => [
    index("ask_usage_user_created_idx").on(t.userId, t.createdAt),
    index("ask_usage_created_idx").on(t.createdAt),
  ],
);

/** Names of the secrets an administrator can store (workspace-settings design decision 1). */
export const WORKSPACE_SECRET_NAMES = [
  "github_private_key",
  "github_webhook_secret",
  "anthropic_api_key",
  "openai_api_key",
] as const;
export type WorkspaceSecretName = (typeof WORKSPACE_SECRET_NAMES)[number];

/**
 * Workspace settings (workspace-settings design decision 1): one row (`id` fixed to 1) holding the
 * validated, non-secret settings as JSON. `version` rises by one on every save and is how a stale
 * save is refused and how other server instances notice a change. No secret is ever stored here.
 */
export const workspaceSettings = pgTable(
  "workspace_settings",
  {
    id: smallint("id").primaryKey(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    version: integer("version").notNull().default(1),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [check("workspace_settings_single_row", sql`${t.id} = 1`)],
);

/**
 * One row per stored secret, encrypted with AES-256-GCM (`ciphertext` holds the cipher text and
 * the authentication tag, base64). The secret's name is the authenticated data, so a value moved
 * to another row fails to decrypt. There is deliberately no clear-text column.
 */
export const workspaceSecrets = pgTable(
  "workspace_secrets",
  {
    name: text("name").primaryKey(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    keyVersion: smallint("key_version").notNull().default(1),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    check(
      "workspace_secrets_name",
      sql`${t.name} in ('github_private_key', 'github_webhook_secret', 'anthropic_api_key', 'openai_api_key')`,
    ),
  ],
);

/** Who changed which settings and when. Field names only; there is no column for a value. */
export const settingsAudit = pgTable("settings_audit", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  fields: text("fields").array().notNull(),
});
