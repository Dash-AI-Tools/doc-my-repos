import { and, eq, getTableColumns, inArray, ne, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client";
import { describeDbError } from "../db/client";
import { codeOwners, documents, repos, type SyncWarning } from "../db/schema";
import { parseCodeowners } from "../docs/codeowners";
import type { FrontmatterData } from "../docs/frontmatter";
import { detectOkf } from "../docs/okf";
import type { RepoLevelResult, TextWarning } from "./blobs";
import { buildDocumentRecord, toDbOwners, toDbText, type DocumentRecord } from "./document-record";

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
 *   stale relative to the documents it guards.
 * - Renames: the same `github_id` with a new owner/name updates the row in place (documents
 *   kept). Any OTHER row whose owner/name equals the new one, ignoring case (GitHub names are
 *   case-insensitive, so two live repos cannot share one), is stale: it is deleted with its
 *   documents and code owners before the upsert, and reported in `replacedRepos`.
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
 * Not done here: taking the per-repo advisory lock (the caller wraps this in `withRepoSyncLock`,
 * task 5.8), `sync_runs` and error status (5.7), and removing repos (5.9).
 *
 * Errors: database failures are rethrown as `PersistError('database')` with only the SQLSTATE in
 * the message (driver messages can name the host and user). Bad input is a programming error
 * and throws a `TypeError` before any write.
 */

export type PersistErrorKind =
  /** The caller's signal aborted; the transaction was rolled back. */
  | "aborted"
  /** An `unchanged` plan does not match the stored row (missing, or another tree/selection). */
  | "stale_plan"
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
  /** Paths kept as stored because their fetch failed (documents, README, CODEOWNERS). */
  failed: string[];
  warnings: SyncWarning[];
  /** Stale rows deleted because they held this repo's new owner/name. */
  replacedRepos: { githubId: number; owner: string; name: string }[];
  isOkf: boolean;
  okfVersion: string | null;
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

  const metadata = {
    owner: toDbText(repo.owner),
    name: toDbText(repo.name),
    description: repo.description === null ? null : toDbText(repo.description),
    defaultBranch: toDbText(repo.defaultBranch),
    archived: repo.archived,
    visibility: mapVisibility(repo.visibility),
    htmlUrl: toDbText(repo.htmlUrl),
  };

  try {
    return await db.transaction(async (tx) => {
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
        replacedRepos: [],
        isOkf: false,
        okfVersion: null,
      };

      // Stale rows holding the new owner/name under another GitHub id (deleted, recreated or
      // renamed repos). Cascades to their documents and code owners.
      result.replacedRepos = await tx
        .delete(repos)
        .where(
          and(
            ne(repos.githubId, repo.githubId),
            sql`lower(${repos.owner}) = lower(${metadata.owner})`,
            sql`lower(${repos.name}) = lower(${metadata.name})`,
          ),
        )
        .returning({ githubId: repos.githubId, owner: repos.owner, name: repos.name });

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
            ...headColumns(plan, true),
            ...okStatus(),
            updatedAt: sql`now()`,
          })
          .where(eq(repos.id, row.id))
          .returning({ isOkf: repos.isOkf, okfVersion: repos.okfVersion });
        result.repoId = row.id;
        result.isOkf = stored?.isOkf ?? false;
        result.okfVersion = stored?.okfVersion ?? null;
        return result;
      }

      const [upserted] = await tx
        .insert(repos)
        .values({ githubId: repo.githubId, ...metadata })
        .onConflictDoUpdate({
          target: repos.githubId,
          set: { ...metadata, updatedAt: sql`now()` },
        })
        .returning({ id: repos.id });
      const repoId = (upserted as { id: number }).id;
      result.repoId = repoId;

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

      checkSignal(signal);
      const failed = plan.failed.map((d) => d.path);
      if (plan.readme.state === "failed") failed.push(plan.readme.file.path);
      if (plan.codeowners.state === "failed") failed.push(plan.codeowners.file.path);
      result.failed = failed.map(toDbText);
      result.complete = failed.length === 0;

      const owners = await writeCodeowners(tx, repoId, plan.codeowners, result.warnings);
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
          ...headColumns(plan, result.complete),
          ...(result.complete ? okStatus() : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(repos.id, repoId));
      return result;
    });
  } catch (error) {
    if (error instanceof PersistError) throw error;
    throw new PersistError(
      "database",
      `persist failed: ${describeDbError(error)}`,
      sqlState(error),
    );
  }
}
