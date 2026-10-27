import { and, eq, getTableColumns, inArray, ne, notInArray, sql, type SQL } from "drizzle-orm";
import type { Pool } from "pg";

import { AdvisoryLockError, withRepoSyncLock } from "../db/advisory-lock";
import type { Db } from "../db/client";
import { describeDbError } from "../db/client";
import { apiSpecs, codeOwners, documents, repos, type SyncWarning } from "../db/schema";
import { parseCodeowners } from "../docs/codeowners";
import type { FrontmatterData } from "../docs/frontmatter";
import { detectOkf } from "../docs/okf";
import { parseApiSpec, type ParsedApiSpec } from "../docs/openapi";
import type { RepoLevelResult, TextWarning } from "./blobs";
import {
  buildDocumentRecord,
  toDbJson,
  toDbOwners,
  toDbText,
  type DocumentRecord,
} from "./document-record";
import { visibilityWrite, type DbInstant } from "./requests";
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_SPEC_BYTES, MAX_API_SPECS } from "./tree";
import { buildRepoSyncWarnings, type WarningSkip } from "./warnings";

/**
 * Persistence: the write side of one repository sync (task 5.6), after `planTree` (5.4) and
 * `syncBlobs` (5.5). Everything for one repo is written in ONE transaction, so readers never see
 * a half-applied sync and a crash or error leaves the previous state in place.
 *
 * What one call writes:
 * - The repo row, keyed by `github_id`: owner, name, description, default branch, archived,
 *   html url and `visibility`. GitHub's `public` is stored as public; anything else (`private`,
 *   Enterprise `internal`, unknown) as private, failing closed. The visibility is written in the
 *   same transaction as the content, so the column the read-side visibility filter uses is never
 *   stale relative to the documents it guards. With `options.listedAt` (the database instant
 *   taken before the listing the metadata came from), a `public` never overwrites a stored
 *   `private` written after that instant (a `privatized` webhook during the sync): the row stays
 *   private, its rerun marker is set, and `visibilityHeld` is reported (`visibilityWrite` in
 *   `requests.ts`).
 * - Renames: the same `github_id` with a new owner/name updates the row in place (documents
 *   kept). Any OTHER row whose owner/name equals the new one, ignoring case (GitHub names are
 *   case-insensitive, so two live repos cannot share one), is stale: it is deleted with its
 *   documents and code owners before the upsert, and reported in `replacedRepos`. With
 *   `options.pool` (the sync engine) the stale row is deleted only under ITS repo's sync lock,
 *   taken in try mode; when that repo is mid-sync the call fails with `name_conflict_busy` and
 *   writes nothing (retried next sync). A `content` plan carrying `storedRepoId` must land in the
 *   row it was diffed against, else `stale_plan` (the engine re-plans).
 * - Documents: `fetched` files are upserted by (repo_id, path); a row whose stored values already
 *   match is not touched (no write, `updated_at` kept), so the same input twice is a no-op.
 *   `removed` paths are deleted. `failed` paths and paths not mentioned are left as stored.
 * - Per-document skips: a fetched file over the size cap (`too_large`), or one Postgres refuses
 *   for its content (`write_rejected`: SQLSTATE class 22 data exception or 54 program limit, such
 *   as a tsvector over 1 MB), is written in its own savepoint, so it never fails the repo's other
 *   documents. Its old row, if any, is deleted (the file cannot be shown as it is now, the same as
 *   a file the tree selection skips), and it is reported in `skipped`. A skip is deterministic
 *   (retrying gives the same result), so it does not make the sync incomplete.
 * - README (`repos.readme_*`): `fetched` stores path, markdown and SHA; `unchanged` updates only
 *   the path (a move with the same content); `absent` clears all three; `failed` keeps them.
 * - CODEOWNERS (`code_owners` rows and `repos.codeowners_*`, which mirror the README pair): on
 *   `fetched` the rows are replaced (delete, then insert in file order with `position` = rule
 *   index) and path/SHA stored with them; `unchanged` updates the path and the rows'
 *   `source_path`; `absent` deletes the rows and clears path/SHA; `failed` keeps everything.
 * - OKF: `is_okf` and `okf_version` from `detectOkf` over the documents stored after the writes
 *   (so unchanged documents count), read back inside the transaction. `docs_path` is the plan's
 *   docs folder.
 * - Visible warnings (task 12.3): `sync_warnings` is rewritten by every `content` plan, complete or
 *   not, from the tree selection's skips and cap (`plan.selection`) plus this call's own skips
 *   (`buildRepoSyncWarnings`), and is empty when nothing was left out. An `unchanged` plan keeps
 *   it (same tree, same selection), and a failed sync never reaches persist, so it keeps it too.
 *
 * - API specs (`api_specs`, openapi-reference): in the same transaction. Fetched spec files are
 *   parsed (`parseApiSpec`, untrusted input) and upserted by (repo_id, path), an identical row not
 *   being written; a spec that does not parse, or that Postgres refuses (`write_rejected`), is NOT
 *   stored and a stored copy of it is deleted (it would no longer match the repository), with a
 *   fixed-reason warning and no failure. `removed` paths are deleted; `failed` paths are kept and
 *   make the sync incomplete. A plan without `apiSpecs` (handcrafted) leaves stored specs alone.
 *
 * Completeness rule. A sync is complete when no document, README or CODEOWNERS fetch failed.
 * - Complete: `tree_sha`, `selection_fingerprint`, `head_etag` and `commit_sha` are set from the
 *   plan, `sync_status = ok`, `sync_error = null`, `last_synced_at = now()`.
 * - Incomplete: the content that did arrive is written, but the head state (those four columns)
 *   is CLEARED, never advanced, so the next sync cannot short-circuit and re-plans from the tree;
 *   only the failed files are refetched, since the rest match by blob SHA. Clearing rather than
 *   keeping the old values matters: if upstream later returned to the old tree, an old `tree_sha`
 *   would short-circuit over content that is partly from the newer tree. `sync_status`,
 *   `sync_error` and `last_synced_at` are left for the caller (task 5.7) to record.
 * - An `unchanged` plan writes repo metadata, the head state and the ok status only. It requires
 *   the stored row to exist with the same `tree_sha` and `selection_fingerprint`; otherwise it
 *   throws `PersistError('stale_plan')` and writes nothing, since marking an unverified row as
 *   synced could hide missing content.
 *
 * Not done here: taking this repo's own advisory lock (the caller wraps this in `withRepoSyncLock`,
 * task 5.8), `sync_runs` and error status (5.7), and removing repos (5.9).
 *
 * Errors: database failures are rethrown as `PersistError('database')` with only the SQLSTATE in
 * the message (driver messages can name the host and user). Bad input is a programming error
 * and throws a `TypeError` before any write.
 */

export type PersistErrorKind =
  /** The caller's signal aborted; the transaction was rolled back. */
  | "aborted"
  /**
   * An `unchanged` plan does not match the stored row (missing, or another tree/selection), or a
   * `content` plan was computed against a stored row (`storedRepoId`) that is no longer the row
   * this repo is stored in (deleted or replaced meanwhile).
   */
  | "stale_plan"
  /**
   * Another stored repository holds this repo's new owner/name and its sync lock is busy (it is
   * being synced or removed right now), so its row cannot be replaced safely. Nothing was
   * written; retryable on the next sync.
   */
  | "name_conflict_busy"
  /** A database statement failed; the transaction was rolled back. */
  | "database";

export class PersistError extends Error {
  readonly kind: PersistErrorKind;
  /** SQLSTATE for `database` errors, when known. */
  readonly code: string | undefined;
  constructor(kind: PersistErrorKind, message: string, code?: string) {
    super(message);
    this.name = "PersistError";
    this.kind = kind;
    this.code = code;
  }
}

/** Repository metadata as listed by GitHub (task 5.3 `DiscoveredRepo` fits). */
export interface PersistRepo {
  githubId: number;
  owner: string;
  name: string;
  description: string | null;
  /** "" for an empty repository. */
  defaultBranch: string;
  archived: boolean;
  /** GitHub's value: `public`, `private`, `internal`, or anything else (stored as private). */
  visibility: string;
  htmlUrl: string;
}

/** The plan's head state; persisted only when the sync is complete. */
export interface PersistHead {
  treeSha: string | null;
  commitSha: string | null;
  headEtag: string | null;
  selectionFingerprint: string;
}

export interface PersistFetchedDoc {
  path: string;
  blobSha: string;
  /** Raw blob size in bytes (`documents.size_bytes`). */
  size: number;
  text: string;
  /** Decoding warnings from `syncBlobs`, reported with the document. */
  warnings?: readonly TextWarning[];
}

export interface PersistFetchedSpec {
  path: string;
  blobSha: string;
  /** Raw blob size in bytes (`api_specs.size_bytes`). */
  size: number;
  text: string;
}

/** The spec half of a content plan (`syncBlobs().apiSpecs` plus what the tree selection left out). */
export interface PersistSpecs {
  fetched: readonly PersistFetchedSpec[];
  /** Stored specs that are no longer selected: deleted. */
  removed: readonly { path: string }[];
  /** Kept as stored; they make the sync incomplete. */
  failed: readonly { path: string }[];
  /** Tree-selection skips (`ApiSpecSkipReason`), for the repository warnings. */
  skipped: readonly WarningSkip[];
  /** Configured `apiSpecs` paths that are not in the repository. */
  missing: readonly string[];
}

export type PersistPlan =
  | ({ kind: "unchanged" } & PersistHead)
  | ({
      kind: "content";
      docsFolder: string | null;
      /** `syncBlobs().fetched`. */
      fetched: readonly PersistFetchedDoc[];
      /** `syncBlobs().removed`. */
      removed: readonly { path: string }[];
      /** `syncBlobs().failed`: kept as stored, and they make the sync incomplete. */
      failed: readonly { path: string }[];
      readme: RepoLevelResult;
      codeowners: RepoLevelResult;
      /**
       * What the tree selection left out (task 12.3), for `repos.sync_warnings`. Absent: no
       * selection skips (handcrafted plans).
       */
      apiSpecs?: PersistSpecs;
      selection?: {
        readonly skipped: readonly WarningSkip[];
        readonly capped: { readonly found: number; readonly limit: number } | null;
      };
      /**
       * The `repos.id` of the stored row whose documents the plan was diffed against, or null when
       * the plan was built with no stored row (a first sync: every selected file fetched). When
       * set (including null), persist checks the row it writes is that same row and otherwise
       * throws `stale_plan` without writing: a plan diffed against stored documents leaves the
       * unchanged ones out of `fetched`, so writing it into a recreated row would drop them while
       * marking the sync complete. Absent (handcrafted plans, seeding): not checked.
       */
      storedRepoId?: number | null;
    } & PersistHead);

export interface PersistInput {
  repo: PersistRepo;
  plan: PersistPlan;
}

export interface PersistOptions {
  /** Checked before the transaction and before each write; an abort rolls everything back. */
  signal?: AbortSignal;
  /** Per-document byte cap for `buildDocumentRecord`. Default 256 KB. */
  maxDocumentBytes?: number;
  /** Per-spec byte cap for `parseApiSpec`. Default 2 MB. */
  maxSpecBytes?: number;
  /**
   * The database instant taken before the listing `repo` came from. When given, a `public`
   * visibility does not overwrite a stored `private` written after it (see the module comment).
   * Without it the visibility is written as listed (callers whose metadata is known fresh).
   */
  listedAt?: DbInstant;
  /**
   * The pool for repository sync locks. When given, a stale row holding this repo's new
   * owner/name (another GitHub id) is deleted only while holding THAT repo's sync lock, taken in
   * try mode before the transaction; a busy lock fails the call with `name_conflict_busy` and
   * nothing is written. Without it the stale row is deleted unguarded: only for single-writer
   * callers (seeding, tests). The sync engine always passes it.
   */
  pool?: Pool;
}

export type PersistSkipReason = "too_large" | "write_rejected";

export interface PersistResult {
  repoId: number;
  /** False when any fetch failed: the head state was cleared and status left to the caller. */
  complete: boolean;
  /** Document rows inserted. */
  added: number;
  /** Document rows whose stored values changed. */
  updated: number;
  /** Fetched documents identical to the stored row (not written). */
  identical: number;
  /** Rows deleted for `removed` paths and for skipped files that had a row. */
  removed: number;
  skipped: { path: string; reason: PersistSkipReason }[];
  /** API spec rows written by this call. */
  apiSpecs: { added: number; updated: number; identical: number; removed: number };
  /** Paths kept as stored because their fetch failed (documents, README, CODEOWNERS, specs). */
  failed: string[];
  warnings: SyncWarning[];
  /** Stale rows deleted because they held this repo's new owner/name. */
  replacedRepos: { githubId: number; owner: string; name: string }[];
  isOkf: boolean;
  okfVersion: string | null;
  /**
   * The listing said `public` but the stored row was made private after `listedAt`: it was kept
   * private and its rerun marker set, so a fresh pass re-reads the visibility.
   */
  visibilityHeld: boolean;
}

/** GitHub visibility to the stored enum: only `public` is public (fail closed). */
export function mapVisibility(visibility: string): "public" | "private" {
  return visibility === "public" ? "public" : "private";
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** SQLSTATE classes treated as "this document's content cannot be stored". */
const PER_DOCUMENT_SQLSTATE = /^(22|54)/;
/** Rows per multi-row code_owners insert (5 parameters each, well under Postgres's 65535). */
const CODE_OWNERS_BATCH = 1000;

const TEXT_WARNING_MESSAGES: Record<TextWarning, string> = {
  invalid_utf8: "invalid UTF-8 was replaced",
  nul_stripped: "NUL characters were removed",
};

function sqlState(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PersistError("aborted", "persist aborted");
}

function requireString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value === "")) {
    throw new TypeError(`${name} must be a ${allowEmpty ? "" : "non-empty "}string`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requireString(value, name);
}

function validateRepo(repo: PersistRepo): void {
  if (!Number.isSafeInteger(repo.githubId) || repo.githubId <= 0) {
    throw new TypeError("repo.githubId must be a positive integer");
  }
  requireString(repo.owner, "repo.owner");
  requireString(repo.name, "repo.name");
  requireString(repo.defaultBranch, "repo.defaultBranch", true);
  requireString(repo.htmlUrl, "repo.htmlUrl");
  requireString(repo.visibility, "repo.visibility", true);
  if (repo.description !== null) requireString(repo.description, "repo.description", true);
  if (typeof repo.archived !== "boolean") throw new TypeError("repo.archived must be a boolean");
}

function validateHead(head: PersistHead): void {
  optionalString(head.treeSha, "plan.treeSha");
  optionalString(head.commitSha, "plan.commitSha");
  optionalString(head.headEtag, "plan.headEtag");
  requireString(head.selectionFingerprint, "plan.selectionFingerprint");
}

/** Paths must be disjoint across fetched/removed/failed, and fetched docs inside the folder. */
function validateContent(plan: Extract<PersistPlan, { kind: "content" }>): void {
  const seen = new Set<string>();
  const add = (path: unknown) => {
    const p = requireString(path, "document path");
    if (seen.has(p)) throw new TypeError("a document path appears more than once in the plan");
    seen.add(p);
  };
  const prefix = plan.docsFolder === null ? null : `${plan.docsFolder.replace(/\/+$/, "")}/`;
  for (const doc of plan.fetched) {
    add(doc.path);
    if (prefix === null || !doc.path.startsWith(prefix)) {
      throw new TypeError("a fetched document is outside the docs folder");
    }
    requireString(doc.blobSha, "fetched blobSha");
    requireString(doc.text, "fetched text", true);
    if (!Number.isSafeInteger(doc.size) || doc.size < 0) {
      throw new TypeError("fetched size must be a non-negative integer");
    }
  }
  for (const doc of plan.removed) add(doc.path);
  for (const doc of plan.failed) add(doc.path);

  const specs = plan.apiSpecs;
  if (specs === undefined) return;
  const seenSpecs = new Set<string>();
  const addSpec = (path: unknown) => {
    const p = requireString(path, "spec path");
    if (seenSpecs.has(p)) throw new TypeError("a spec path appears more than once in the plan");
    seenSpecs.add(p);
  };
  for (const spec of specs.fetched) {
    addSpec(spec.path);
    requireString(spec.blobSha, "fetched spec blobSha");
    requireString(spec.text, "fetched spec text", true);
    if (!Number.isSafeInteger(spec.size) || spec.size < 0) {
      throw new TypeError("fetched spec size must be a non-negative integer");
    }
  }
  for (const spec of specs.removed) addSpec(spec.path);
  for (const spec of specs.failed) addSpec(spec.path);
  if (specs.fetched.length + specs.failed.length > MAX_API_SPECS) {
    throw new TypeError("a plan holds more API specs than the per-repository limit");
  }
}

interface PreparedDoc {
  record: DocumentRecord;
  blobSha: string;
  size: number;
}

interface Prepared {
  docs: PreparedDoc[];
  tooLarge: string[];
  warnings: SyncWarning[];
}

/** Pure work done before the transaction, to keep it short. */
function prepareDocuments(
  plan: Extract<PersistPlan, { kind: "content" }>,
  maxBytes: number | undefined,
): Prepared {
  const out: Prepared = { docs: [], tooLarge: [], warnings: [] };
  for (const doc of plan.fetched) {
    for (const w of doc.warnings ?? []) {
      out.warnings.push({ path: toDbText(doc.path), message: TEXT_WARNING_MESSAGES[w] ?? w });
    }
    const built = buildDocumentRecord(doc.path, doc.text, {
      docsFolder: plan.docsFolder,
      maxBytes,
    });
    for (const message of built.warnings) {
      out.warnings.push({ path: built.ok ? built.record.path : built.path, message });
    }
    if (built.ok) out.docs.push({ record: built.record, blobSha: doc.blobSha, size: doc.size });
    else out.tooLarge.push(doc.path);
  }
  return out;
}

interface PreparedSpec {
  path: string;
  blobSha: string;
  size: number;
  spec: ParsedApiSpec;
}

interface PreparedSpecs {
  specs: PreparedSpec[];
  /** Fetched files that are not specs (or too large): any stored row is deleted. */
  rejected: { path: string; reason: string }[];
}

/** Parses the fetched spec files, before the transaction. Never throws on bad content. */
function prepareSpecs(plan: Extract<PersistPlan, { kind: "content" }>, maxBytes: number) {
  const out: PreparedSpecs = { specs: [], rejected: [] };
  for (const file of plan.apiSpecs?.fetched ?? []) {
    const parsed = parseApiSpec(file.text, toDbText(file.path), { maxBytes });
    if (parsed.ok) {
      out.specs.push({
        path: toDbText(file.path),
        blobSha: file.blobSha,
        size: file.size,
        spec: parsed,
      });
    } else out.rejected.push({ path: toDbText(file.path), reason: parsed.reason });
  }
  return out;
}

/** The api_specs columns a sync writes besides the key; the upsert compares exactly these. */
function specSet(item: PreparedSpec) {
  const { spec } = item;
  return {
    blobSha: toDbText(item.blobSha),
    sizeBytes: item.size,
    format: spec.format,
    specVersion: toDbText(spec.specVersion),
    title: toDbText(spec.title),
    apiVersion: spec.apiVersion === null ? null : toDbText(spec.apiVersion),
    operationCount: spec.operationCount,
    spec: toDbJson(spec.spec) as Record<string, unknown>,
  };
}

async function upsertSpec(
  tx: Tx,
  repoId: number,
  item: PreparedSpec,
): Promise<"added" | "updated" | "identical"> {
  const set = specSet(item);
  const columns = getTableColumns(apiSpecs);
  const names = (Object.keys(set) as (keyof typeof set)[]).map((key) => columns[key].name);
  const stored = sql.raw(names.map((n) => `"api_specs"."${n}"`).join(", "));
  const incoming = sql.raw(names.map((n) => `excluded."${n}"`).join(", "));
  const rows = await tx
    .insert(apiSpecs)
    .values({ repoId, path: item.path, ...set })
    .onConflictDoUpdate({
      target: [apiSpecs.repoId, apiSpecs.path],
      set: { ...set, updatedAt: sql`now()` },
      // An identical row is not written, so a repeated input keeps `updated_at`.
      setWhere: sql`(${stored}) IS DISTINCT FROM (${incoming})`,
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  const row = rows[0];
  if (row === undefined) return "identical";
  return row.inserted ? "added" : "updated";
}

async function deleteSpecs(tx: Tx, repoId: number, paths: readonly string[]): Promise<number> {
  if (paths.length === 0) return 0;
  const rows = await tx
    .delete(apiSpecs)
    .where(and(eq(apiSpecs.repoId, repoId), inArray(apiSpecs.path, [...paths])))
    .returning({ id: apiSpecs.id });
  return rows.length;
}

/** The documents columns a sync writes besides the key; the upsert compares exactly these. */
function documentSet(doc: PreparedDoc) {
  return {
    blobSha: toDbText(doc.blobSha),
    sizeBytes: doc.size,
    title: doc.record.title,
    description: doc.record.description,
    type: doc.record.type,
    tags: doc.record.tags,
    status: doc.record.status,
    headings: doc.record.headings,
    frontmatter: doc.record.frontmatter as Record<string, unknown>,
    body: doc.record.body,
    reserved: doc.record.reserved,
  };
}

type DocumentSet = ReturnType<typeof documentSet>;

/** `(stored columns) IS DISTINCT FROM (incoming columns)`, built from the same keys as the set. */
function changedCondition(set: DocumentSet): SQL {
  const columns = getTableColumns(documents);
  const names = (Object.keys(set) as (keyof DocumentSet)[]).map((key) => columns[key].name);
  const stored = sql.raw(names.map((n) => `"documents"."${n}"`).join(", "));
  const incoming = sql.raw(names.map((n) => `excluded."${n}"`).join(", "));
  return sql`(${stored}) IS DISTINCT FROM (${incoming})`;
}

/** Upserts one document; returns how the row changed. */
async function upsertDocument(
  tx: Tx,
  repoId: number,
  doc: PreparedDoc,
): Promise<"added" | "updated" | "identical"> {
  const set = documentSet(doc);
  const rows = await tx
    .insert(documents)
    .values({ repoId, path: doc.record.path, ...set })
    .onConflictDoUpdate({
      target: [documents.repoId, documents.path],
      set: { ...set, updatedAt: sql`now()` },
      // An identical row is not written, so a repeated input keeps `updated_at` and the vector.
      setWhere: changedCondition(set),
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  const row = rows[0];
  if (row === undefined) return "identical";
  return row.inserted ? "added" : "updated";
}

async function deleteDocuments(tx: Tx, repoId: number, paths: readonly string[]): Promise<number> {
  if (paths.length === 0) return 0;
  const rows = await tx
    .delete(documents)
    .where(and(eq(documents.repoId, repoId), inArray(documents.path, [...paths])))
    .returning({ id: documents.id });
  return rows.length;
}

async function writeCodeowners(
  tx: Tx,
  repoId: number,
  result: RepoLevelResult,
  warnings: SyncWarning[],
): Promise<{ codeownersPath?: string | null; codeownersSha?: string | null }> {
  switch (result.state) {
    case "failed":
      return {};
    case "unchanged": {
      const path = toDbText(result.file.path);
      await tx
        .update(codeOwners)
        .set({ sourcePath: path })
        .where(and(eq(codeOwners.repoId, repoId), ne(codeOwners.sourcePath, path)));
      return { codeownersPath: path };
    }
    case "absent":
      await tx.delete(codeOwners).where(eq(codeOwners.repoId, repoId));
      return { codeownersPath: null, codeownersSha: null };
    case "fetched": {
      const path = toDbText(result.file.path);
      const parsed = parseCodeowners(result.text);
      for (const message of parsed.warnings) warnings.push({ path, message });
      await tx.delete(codeOwners).where(eq(codeOwners.repoId, repoId));
      const rows = parsed.rules.map((rule, position) => ({
        repoId,
        position,
        pattern: toDbText(rule.pattern),
        owners: toDbOwners(rule.owners),
        sourcePath: path,
      }));
      for (let i = 0; i < rows.length; i += CODE_OWNERS_BATCH) {
        await tx.insert(codeOwners).values(rows.slice(i, i + CODE_OWNERS_BATCH));
      }
      return { codeownersPath: path, codeownersSha: toDbText(result.file.blobSha) };
    }
  }
}

function readmeColumns(result: RepoLevelResult): {
  readmePath?: string | null;
  readmeMarkdown?: string | null;
  readmeSha?: string | null;
} {
  switch (result.state) {
    case "failed":
      return {};
    case "unchanged":
      return { readmePath: toDbText(result.file.path) };
    case "absent":
      return { readmePath: null, readmeMarkdown: null, readmeSha: null };
    case "fetched":
      return {
        readmePath: toDbText(result.file.path),
        readmeMarkdown: toDbText(result.text),
        readmeSha: toDbText(result.file.blobSha),
      };
  }
}

/** OKF detection over the rows stored now, reading only the two keys `detectOkf` looks at. */
async function detectStoredOkf(
  tx: Tx,
  repoId: number,
  docsFolder: string | null,
): Promise<{ isOkf: boolean; okfVersion: string | null }> {
  if (docsFolder === null) return { isOkf: false, okfVersion: null };
  const rows = await tx
    .select({
      path: documents.path,
      frontmatter: sql<FrontmatterData>`(SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) FROM jsonb_each(${documents.frontmatter}) WHERE key IN ('type', 'okf_version'))`,
    })
    .from(documents)
    .where(eq(documents.repoId, repoId));
  const okf = detectOkf(rows, docsFolder);
  return { isOkf: okf.isOkf, okfVersion: okf.isOkf ? (okf.okfVersion ?? null) : null };
}

function headColumns(head: PersistHead, complete: boolean) {
  if (!complete) {
    return { treeSha: null, selectionFingerprint: null, headEtag: null, commitSha: null };
  }
  return {
    treeSha: head.treeSha === null ? null : toDbText(head.treeSha),
    selectionFingerprint: toDbText(head.selectionFingerprint),
    headEtag: head.headEtag === null ? null : toDbText(head.headEtag),
    commitSha: head.commitSha === null ? null : toDbText(head.commitSha),
  };
}

const okStatus = () => ({
  syncStatus: "ok" as const,
  syncError: null,
  lastSyncedAt: sql`now()`,
});

/**
 * Writes one repository's sync result in a single transaction. See the module comment for the
 * rules. Call it while holding the repo's sync lock (`withRepoSyncLock`).
 */
export async function persistRepoSync(
  db: Db,
  input: PersistInput,
  options: PersistOptions = {},
): Promise<PersistResult> {
  const { repo, plan } = input;
  const { signal } = options;
  validateRepo(repo);
  validateHead(plan);
  if (plan.kind === "content") validateContent(plan);
  checkSignal(signal);

  const prepared: Prepared =
    plan.kind === "content"
      ? prepareDocuments(plan, options.maxDocumentBytes)
      : { docs: [], tooLarge: [], warnings: [] };
  const maxSpecBytes = options.maxSpecBytes ?? DEFAULT_MAX_SPEC_BYTES;
  const preparedSpecs: PreparedSpecs =
    plan.kind === "content" ? prepareSpecs(plan, maxSpecBytes) : { specs: [], rejected: [] };

  const metadata = {
    owner: toDbText(repo.owner),
    name: toDbText(repo.name),
    description: repo.description === null ? null : toDbText(repo.description),
    defaultBranch: toDbText(repo.defaultBranch),
    archived: repo.archived,
    visibility: mapVisibility(repo.visibility),
    htmlUrl: toDbText(repo.htmlUrl),
  };
  // On an existing row: the listed visibility, or a public guarded against a newer private.
  const visibilitySet =
    options.listedAt === undefined
      ? { visibility: metadata.visibility }
      : visibilityWrite(metadata.visibility, options.listedAt);
  const heldPrivate = (stored: "public" | "private" | undefined) =>
    metadata.visibility === "public" && stored === "private";

  // Rows of OTHER repositories holding this repo's new owner/name (deleted, recreated or renamed
  // repos), matched ignoring case as GitHub does.
  const nameConflict = and(
    ne(repos.githubId, repo.githubId),
    sql`lower(${repos.owner}) = lower(${metadata.owner})`,
    sql`lower(${repos.name}) = lower(${metadata.name})`,
  );
  const { pool } = options;

  /**
   * Runs `fn` while holding the sync locks of `ids` (try mode, one after another). A busy lock
   * throws `name_conflict_busy`: that repo is being synced or removed right now, and deleting its
   * row under it could make its sync write a plan diffed against stored documents into a fresh
   * row (see `storedRepoId`). Try mode cannot deadlock, even when two repos swap names.
   */
  async function holdingLocks<T>(ids: readonly number[], fn: () => Promise<T>): Promise<T> {
    const [first, ...rest] = ids;
    if (first === undefined || pool === undefined) return fn();
    const lock = await withRepoSyncLock(pool, { githubId: first }, () => holdingLocks(rest, fn), {
      signal,
      waitMs: 0,
    });
    if (lock.acquired) return lock.value;
    if (lock.reason === "aborted") throw new PersistError("aborted", "persist aborted");
    throw new PersistError(
      "name_conflict_busy",
      "another repository with this name is being synced; retried on the next sync",
    );
  }

  try {
    const conflicting =
      pool === undefined
        ? []
        : (
            await db
              .select({ githubId: repos.githubId })
              .from(repos)
              .where(nameConflict)
              .orderBy(repos.githubId)
          ).map((r) => r.githubId);
    return await holdingLocks(conflicting, () => writeTransaction(conflicting));
  } catch (error) {
    if (error instanceof PersistError || error instanceof AdvisoryLockError) throw error;
    throw new PersistError(
      "database",
      `persist failed: ${describeDbError(error)}`,
      sqlState(error),
    );
  }

  async function writeTransaction(locked: readonly number[]): Promise<PersistResult> {
    return db.transaction(async (tx) => {
      checkSignal(signal);
      const result: PersistResult = {
        repoId: 0,
        complete: true,
        added: 0,
        updated: 0,
        identical: 0,
        removed: 0,
        skipped: [],
        failed: [],
        warnings: [...prepared.warnings],
        apiSpecs: { added: 0, updated: 0, identical: 0, removed: 0 },
        replacedRepos: [],
        isOkf: false,
        okfVersion: null,
        visibilityHeld: false,
      };

      // Stale rows holding the new owner/name under another GitHub id (deleted, recreated or
      // renamed repos). Cascades to their documents and code owners. With a pool, only rows whose
      // sync lock this call holds are deleted; a conflicting row that appeared after the locks
      // were taken fails the call (retried next sync) rather than being deleted unlocked.
      if (pool === undefined) {
        result.replacedRepos = await tx
          .delete(repos)
          .where(nameConflict)
          .returning({ githubId: repos.githubId, owner: repos.owner, name: repos.name });
      } else {
        if (locked.length > 0) {
          result.replacedRepos = await tx
            .delete(repos)
            .where(and(nameConflict, inArray(repos.githubId, [...locked])))
            .returning({ githubId: repos.githubId, owner: repos.owner, name: repos.name });
        }
        const unlocked = tx.select({ id: repos.id }).from(repos);
        const [late] = await (
          locked.length > 0
            ? unlocked.where(and(nameConflict, notInArray(repos.githubId, [...locked])))
            : unlocked.where(nameConflict)
        ).limit(1);
        if (late !== undefined) {
          throw new PersistError(
            "name_conflict_busy",
            "another repository with this name is being synced; retried on the next sync",
          );
        }
      }

      if (plan.kind === "unchanged") {
        const [row] = await tx
          .select({
            id: repos.id,
            treeSha: repos.treeSha,
            selectionFingerprint: repos.selectionFingerprint,
          })
          .from(repos)
          .where(eq(repos.githubId, repo.githubId))
          .for("update");
        if (
          row === undefined ||
          row.treeSha === null ||
          row.treeSha !== plan.treeSha ||
          row.selectionFingerprint !== plan.selectionFingerprint
        ) {
          throw new PersistError("stale_plan", "the stored repository does not match the plan");
        }
        const [stored] = await tx
          .update(repos)
          .set({
            ...metadata,
            ...visibilitySet,
            ...headColumns(plan, true),
            ...okStatus(),
            updatedAt: sql`now()`,
          })
          .where(eq(repos.id, row.id))
          .returning({
            isOkf: repos.isOkf,
            okfVersion: repos.okfVersion,
            visibility: repos.visibility,
          });
        result.repoId = row.id;
        result.isOkf = stored?.isOkf ?? false;
        result.okfVersion = stored?.okfVersion ?? null;
        result.visibilityHeld = heldPrivate(stored?.visibility);
        return result;
      }

      const [upserted] = await tx
        .insert(repos)
        .values({ githubId: repo.githubId, ...metadata })
        .onConflictDoUpdate({
          target: repos.githubId,
          set: { ...metadata, ...visibilitySet, updatedAt: sql`now()` },
        })
        .returning({
          id: repos.id,
          visibility: repos.visibility,
          inserted: sql<boolean>`(xmax = 0)`,
        });
      const repoId = (upserted as { id: number }).id;
      // The plan was diffed against another row than the one written now (or against none while
      // a row exists): writing it would leave out the documents it took as unchanged.
      if (plan.storedRepoId !== undefined) {
        const stale =
          plan.storedRepoId === null ? upserted?.inserted !== true : repoId !== plan.storedRepoId;
        if (stale) {
          throw new PersistError("stale_plan", "the stored repository does not match the plan");
        }
      }
      result.repoId = repoId;
      result.visibilityHeld = heldPrivate(upserted?.visibility);

      // Removals first, then upserts, each document in its own savepoint.
      checkSignal(signal);
      result.removed += await deleteDocuments(
        tx,
        repoId,
        plan.removed.map((d) => d.path),
      );

      const skippedPaths: string[] = [];
      for (const path of prepared.tooLarge) {
        result.skipped.push({ path: toDbText(path), reason: "too_large" });
        skippedPaths.push(path);
      }
      for (const doc of prepared.docs) {
        checkSignal(signal);
        try {
          const outcome = await tx.transaction((sp) => upsertDocument(sp, repoId, doc));
          result[outcome] += 1;
        } catch (error) {
          const code = sqlState(error);
          if (code === undefined || !PER_DOCUMENT_SQLSTATE.test(code)) throw error;
          result.skipped.push({ path: doc.record.path, reason: "write_rejected" });
          result.warnings.push({
            path: doc.record.path,
            message: `document skipped: the database rejected it (${describeDbError(error)})`,
          });
          skippedPaths.push(doc.record.path);
        }
      }
      result.removed += await deleteDocuments(tx, repoId, skippedPaths);

      // API specs, same transaction. A plan without `apiSpecs` leaves the stored ones alone.
      const specSkips: WarningSkip[] = [];
      if (plan.apiSpecs !== undefined) {
        const stale: string[] = plan.apiSpecs.removed.map((s) => s.path);
        for (const rejected of preparedSpecs.rejected) {
          // The only parser reason that is a size, so the warning says "too large".
          specSkips.push({
            path: rejected.path,
            reason: rejected.reason === "too_large" ? "too_large" : "invalid",
          });
          result.warnings.push({
            path: rejected.path,
            message: `API spec not stored: ${rejected.reason}`,
          });
          stale.push(rejected.path);
        }
        for (const item of preparedSpecs.specs) {
          checkSignal(signal);
          try {
            const outcome = await tx.transaction((sp) => upsertSpec(sp, repoId, item));
            result.apiSpecs[outcome] += 1;
          } catch (error) {
            const code = sqlState(error);
            if (code === undefined || !PER_DOCUMENT_SQLSTATE.test(code)) throw error;
            specSkips.push({ path: item.path, reason: "write_rejected" });
            result.warnings.push({
              path: item.path,
              message: "API spec not stored: write_rejected",
            });
            stale.push(item.path);
          }
        }
        result.apiSpecs.removed = await deleteSpecs(tx, repoId, stale);
        for (const missing of plan.apiSpecs.missing) {
          specSkips.push({ path: toDbText(missing), reason: "missing" });
        }
      }

      checkSignal(signal);
      const failed = plan.failed.map((d) => d.path);
      for (const spec of plan.apiSpecs?.failed ?? []) failed.push(spec.path);
      if (plan.readme.state === "failed") failed.push(plan.readme.file.path);
      if (plan.codeowners.state === "failed") failed.push(plan.codeowners.file.path);
      result.failed = failed.map(toDbText);
      result.complete = failed.length === 0;

      const owners = await writeCodeowners(tx, repoId, plan.codeowners, result.warnings);
      const syncWarnings = buildRepoSyncWarnings({
        skipped: [...(plan.selection?.skipped ?? []), ...result.skipped],
        capped: plan.selection?.capped ?? null,
        maxFileBytes: options.maxDocumentBytes ?? DEFAULT_MAX_FILE_BYTES,
        apiSpecs: {
          skipped: [
            ...(plan.apiSpecs?.skipped ?? []).map((s) => ({ path: s.path, reason: s.reason })),
            ...specSkips,
          ],
          maxSpecBytes,
          limit: MAX_API_SPECS,
        },
      });
      const okf = await detectStoredOkf(tx, repoId, plan.docsFolder);
      result.isOkf = okf.isOkf;
      result.okfVersion = okf.okfVersion;

      checkSignal(signal);
      await tx
        .update(repos)
        .set({
          ...readmeColumns(plan.readme),
          ...owners,
          docsPath: plan.docsFolder === null ? null : toDbText(plan.docsFolder),
          isOkf: okf.isOkf,
          okfVersion: okf.okfVersion === null ? null : toDbText(okf.okfVersion),
          syncWarnings,
          ...headColumns(plan, result.complete),
          ...(result.complete ? okStatus() : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(repos.id, repoId));
      return result;
    });
  }
}
