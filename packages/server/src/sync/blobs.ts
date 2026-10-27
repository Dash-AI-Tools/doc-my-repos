import {
  GitHubError,
  type CallOptions,
  type GitHubClient,
  type GitHubErrorKind,
} from "../github/client";
import { DEFAULT_MAX_FILE_BYTES, type PlannedFile, type RepoLevelFiles } from "./tree";

/**
 * Blob diffing and fetching: the second step of a repository sync, after `planTree` (task 5.4) and
 * before persistence (task 5.6). Pure over an injected client; nothing here touches the database.
 *
 * Diff (`diffFiles`): planned files are compared with the blob SHAs stored for the repo, by exact
 * path (case-sensitive, as Git paths are). There is no rename detection: a renamed file is the old
 * path in `removed` plus the new path in `added`, and its content is fetched again.
 *
 * Fetch (`fetchBlobs`): only the given files, through a small worker pool of at most `concurrency`
 * requests in flight. Output keeps the input order whatever order the requests finish in.
 *
 * Failure model, which the caller (tasks 5.6 and 5.7) relies on:
 * - A per-file problem is recorded in `failed` and the other files carry on: `not_found`, `server`,
 *   `network`, `invalid_response`, `client_error`, `invalid_input`, and the local checks
 *   `too_large`, `size_mismatch` and `budget_exceeded`. The caller keeps the stored row for such a
 *   file (or stores nothing for a new one); a failed file is never treated as removed.
 * - Errors that make the rest of the run pointless or unsafe are thrown, not recorded, and partial
 *   results are discarded: `rate_limited` (with `retryAfterMs`), `unauthorized`, `forbidden`,
 *   `app_credentials`, `invalid_private_key`, `installation_unavailable`, and `aborted` (the
 *   caller's signal). The thrown value is the original `GitHubError`, so its kind and
 *   `retryAfterMs` reach the caller; the caller records a repo error and keeps all stored content.
 *   On such an error no new request is started and the requests in flight are cancelled through
 *   their signal. Anything that is not a `GitHubError` is a bug and is thrown the same way.
 *
 * Text: blob bytes are decoded as UTF-8 with invalid sequences replaced by U+FFFD, a leading BOM
 * removed, and NUL characters removed (Postgres text and JSONB reject `\u0000`). Blob content is
 * untrusted; the decoded text is only ever parsed, never executed.
 */

/** Default most requests in flight at once. */
export const DEFAULT_BLOB_CONCURRENCY = 8;
/** Default byte budget for one run: 64 MiB (256 docs at the 256 KB cap). */
export const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Kinds that end the whole fetch: continuing would only fail again or act on revoked access. */
const FATAL_KINDS: ReadonlySet<GitHubErrorKind> = new Set<GitHubErrorKind>([
  "rate_limited",
  "unauthorized",
  "forbidden",
  "app_credentials",
  "invalid_private_key",
  "installation_unavailable",
  "aborted",
]);

export function isFatalBlobError(kind: GitHubErrorKind): boolean {
  return FATAL_KINDS.has(kind);
}

export type BlobFailureKind =
  | Exclude<
      GitHubErrorKind,
      | "rate_limited"
      | "unauthorized"
      | "forbidden"
      | "app_credentials"
      | "invalid_private_key"
      | "installation_unavailable"
      | "aborted"
    >
  /** The fetched content is larger than `maxFileBytes`. */
  | "too_large"
  /** The fetched content's length differs from the size the tree reported. */
  | "size_mismatch"
  /** Not fetched: the run's `maxTotalBytes` budget was already used up. */
  | "budget_exceeded";

export type TextWarning =
  /** Bytes that were not valid UTF-8 were replaced with U+FFFD. */
  | "invalid_utf8"
  /** NUL characters were removed. */
  | "nul_stripped";

export interface FetchedBlob {
  path: string;
  blobSha: string;
  /** Size in bytes of the raw blob. */
  size: number;
  text: string;
  warnings: TextWarning[];
}

export interface FailedBlob {
  path: string;
  blobSha: string;
  kind: BlobFailureKind;
}

export interface FetchResult {
  /** In input order. */
  fetched: FetchedBlob[];
  /** In input order. */
  failed: FailedBlob[];
}

/** A file to fetch. `size` is the size from the tree, checked against the fetched bytes. */
export type BlobFile = Pick<PlannedFile, "path" | "blobSha" | "size"> & {
  /** Per-file cap in bytes, replacing `FetchOptions.maxFileBytes` (API specs have their own). */
  maxBytes?: number;
};

export interface BlobRepo {
  owner: string;
  name: string;
}

export interface FetchOptions extends CallOptions {
  /** Most requests in flight at once. Default 8. */
  concurrency?: number;
  /** Per-file cap on the fetched bytes. Default 256 KB, the same cap the tree selection uses. */
  maxFileBytes?: number;
  /**
   * Byte budget for the run, reserved per file from the tree's size before its request starts.
   * Files that no longer fit are `budget_exceeded` and not fetched; smaller later files that still
   * fit are fetched. Reservations are made in input order and never released, so the outcome does
   * not depend on request timing. Default 64 MiB.
   */
  maxTotalBytes?: number;
}

export type BlobClient = Pick<GitHubClient, "getBlob">;

// ---------------------------------------------------------------------------------------------
// Diff

export interface BlobDiff {
  /** Planned paths with no stored row. Sorted by path. */
  added: BlobFile[];
  /** Planned paths whose stored blob SHA differs. Sorted by path. */
  modified: BlobFile[];
  /** Planned paths whose stored blob SHA is the same. Never fetched. Sorted by path. */
  unchanged: BlobFile[];
  /** Stored paths that are not in the plan. Sorted by path. */
  removed: { path: string; blobSha: string }[];
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return compareCodeUnits(a.path, b.path);
}

/** Throws a `TypeError` naming the first duplicated path. Tree paths are unique, so this is a bug. */
function assertUniquePaths(files: readonly { path: string }[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw new TypeError("duplicate path in blob file list");
    seen.add(file.path);
  }
}

/**
 * Splits the planned files into added, modified and unchanged against the stored blob SHAs, and
 * lists stored paths missing from the plan as removed. Paths compare exactly (case-sensitive).
 * Blob SHAs compare case-insensitively, since GitHub may print hex in either case. Duplicate
 * planned paths are a programming error and throw a `TypeError`.
 */
export function diffFiles(
  files: readonly BlobFile[],
  storedBlobShas: ReadonlyMap<string, string>,
): BlobDiff {
  assertUniquePaths(files);
  const diff: BlobDiff = { added: [], modified: [], unchanged: [], removed: [] };
  const planned = new Set<string>();
  for (const file of files) {
    planned.add(file.path);
    const stored = storedBlobShas.get(file.path);
    const entry: BlobFile = { path: file.path, blobSha: file.blobSha, size: file.size };
    if (stored === undefined) diff.added.push(entry);
    else if (stored.toLowerCase() !== file.blobSha.toLowerCase()) diff.modified.push(entry);
    else diff.unchanged.push(entry);
  }
  for (const [path, blobSha] of storedBlobShas) {
    if (!planned.has(path)) diff.removed.push({ path, blobSha });
  }
  diff.added.sort(byPath);
  diff.modified.sort(byPath);
  diff.unchanged.sort(byPath);
  diff.removed.sort(byPath);
  return diff;
}

// ---------------------------------------------------------------------------------------------
// Text decoding

/** Decodes untrusted blob bytes to text: lossy UTF-8, BOM removed, NUL removed. */
export function decodeBlobText(bytes: Uint8Array): { text: string; warnings: TextWarning[] } {
  const warnings: TextWarning[] = [];
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    warnings.push("invalid_utf8");
    text = new TextDecoder("utf-8").decode(bytes);
  }
  // TextDecoder drops one leading BOM by default; a second (or one after lossy decoding) stays
  // ordinary text, which is what Git would show too.
  if (text.includes("\u0000")) {
    warnings.push("nul_stripped");
    text = text.replaceAll("\u0000", "");
  }
  return { text, warnings };
}

// ---------------------------------------------------------------------------------------------
// Fetch

function positiveInt(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

type Outcome = { ok: FetchedBlob } | { fail: FailedBlob };

/**
 * The worker pool behind `fetchBlobs` and `syncBlobs`. Returns one outcome per input file, at the
 * same index. Does not check for duplicate paths.
 */
async function runFetch(
  client: BlobClient,
  repo: BlobRepo,
  files: readonly BlobFile[],
  options: FetchOptions,
): Promise<Outcome[]> {
  const concurrency = positiveInt(options.concurrency ?? DEFAULT_BLOB_CONCURRENCY, "concurrency");
  const maxFileBytes = positiveInt(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, "maxFileBytes");
  const maxTotalBytes = positiveInt(
    options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    "maxTotalBytes",
  );
  const outer = options.signal;

  if (outer?.aborted) throw new GitHubError("aborted");
  if (files.length === 0) return [];

  // One controller cancels the requests in flight on a fatal error or the caller's abort.
  const controller = new AbortController();
  let fatal: unknown = null;
  let rejectFatal: (error: unknown) => void = () => undefined;
  const fatalPromise = new Promise<never>((_, reject) => {
    rejectFatal = reject;
  });
  // Avoid an unhandled rejection if the pool finishes in the same tick as a late abort.
  fatalPromise.catch(() => undefined);
  const stop = (error: unknown) => {
    if (fatal !== null) return;
    fatal = error;
    controller.abort();
    rejectFatal(error);
  };
  const onAbort = () => stop(new GitHubError("aborted"));
  outer?.addEventListener("abort", onAbort, { once: true });

  const results: (Outcome | null)[] = files.map(() => null);
  let next = 0;
  let reserved = 0;

  const fetchOne = async (file: BlobFile): Promise<Outcome> => {
    const fail = (kind: BlobFailureKind) => ({
      fail: { path: file.path, blobSha: file.blobSha, kind },
    });
    const cap = file.maxBytes ?? maxFileBytes;
    if (file.size > cap) return fail("too_large");
    if (reserved + file.size > maxTotalBytes) return fail("budget_exceeded");
    reserved += file.size;
    let bytes: Uint8Array;
    try {
      ({ bytes } = await client.getBlob(repo.owner, repo.name, file.blobSha, {
        signal: controller.signal,
      }));
    } catch (error) {
      if (error instanceof GitHubError && !FATAL_KINDS.has(error.kind)) {
        return fail(error.kind as BlobFailureKind);
      }
      throw error;
    }
    if (bytes.length > cap) return fail("too_large");
    if (bytes.length !== file.size) return fail("size_mismatch");
    const { text, warnings } = decodeBlobText(bytes);
    return { ok: { path: file.path, blobSha: file.blobSha, size: bytes.length, text, warnings } };
  };

  const worker = async () => {
    while (fatal === null && next < files.length) {
      const index = next++;
      const file = files[index] as BlobFile;
      try {
        const result = await fetchOne(file);
        if (fatal === null) results[index] = result;
      } catch (error) {
        // A request cancelled because another worker hit a fatal error reports that error, not
        // its own `aborted`.
        stop(error);
        return;
      }
    }
  };

  try {
    const workers = Array.from({ length: Math.min(concurrency, files.length) }, worker);
    await Promise.race([Promise.all(workers), fatalPromise]);
    if (fatal !== null) throw fatal;
  } finally {
    outer?.removeEventListener("abort", onAbort);
  }

  // Without a fatal error every worker ran until the queue was empty, so no slot is null.
  return results as Outcome[];
}

function collect(outcomes: readonly Outcome[]): FetchResult {
  const out: FetchResult = { fetched: [], failed: [] };
  for (const outcome of outcomes) {
    if ("ok" in outcome) out.fetched.push(outcome.ok);
    else out.failed.push(outcome.fail);
  }
  return out;
}

/**
 * Fetches exactly the given files with bounded concurrency. See the module comment for the
 * failure model. Duplicate paths are a programming error and throw a `TypeError` before any
 * request. An empty list makes no request.
 */
export async function fetchBlobs(
  client: BlobClient,
  repo: BlobRepo,
  files: readonly BlobFile[],
  options: FetchOptions = {},
): Promise<FetchResult> {
  assertUniquePaths(files);
  return collect(await runFetch(client, repo, files, options));
}

// ---------------------------------------------------------------------------------------------
// Diff + fetch

/** Stored blob SHAs of the repo-level files (`repos.readme_sha`, `repos.codeowners_sha`). */
export interface StoredRepoLevelShas {
  readmeSha: string | null;
  codeownersSha: string | null;
}

export type RepoLevelResult =
  /** Not in the plan. The caller clears what it stored, if anything. */
  | { state: "absent" }
  /** Same path and blob SHA as stored. Not fetched; the caller keeps what it stored. */
  | { state: "unchanged"; file: BlobFile }
  | { state: "fetched"; file: BlobFile; text: string; warnings: TextWarning[] }
  /** The fetch failed; the caller keeps what it stored. */
  | { state: "failed"; file: BlobFile; kind: BlobFailureKind };

export interface SyncBlobsInput {
  files: readonly BlobFile[];
  /** Stored blob SHA per document path. */
  stored: ReadonlyMap<string, string>;
  /**
   * OpenAPI/Swagger spec files from the plan, diffed like documents against the stored blob SHA per
   * spec path. Fetched after the documents and repo-level files, so they use the byte budget last.
   */
  apiSpecs?: {
    files: readonly BlobFile[];
    stored: ReadonlyMap<string, string>;
    /** Per-spec cap in bytes (`limits.maxSpecBytes`). */
    maxBytes: number;
  };
  /** README and CODEOWNERS from the plan, with the SHAs stored for them. Optional. */
  repoLevel?: {
    files: RepoLevelFiles;
    stored: StoredRepoLevelShas;
  };
}

/** The spec half of `syncBlobs`: same rules as documents (`fetched` upsert, `removed` delete). */
export interface SpecBlobsResult extends FetchResult {
  /** Same blob SHA as stored: not fetched, left as stored. */
  unchanged: BlobFile[];
  /** Stored spec paths missing from the plan. */
  removed: { path: string; blobSha: string }[];
}

export interface SyncBlobsResult extends BlobDiff, FetchResult {
  repoLevel: { readme: RepoLevelResult; codeowners: RepoLevelResult };
  apiSpecs: SpecBlobsResult;
}

/**
 * Diffs the planned docs against the stored SHAs and fetches only the added and modified ones,
 * plus a README or CODEOWNERS whose SHA changed, in one pool sharing one byte budget.
 *
 * For the caller (task 5.6): upsert `fetched`; delete `removed`; leave `unchanged` and every path
 * in `failed` as stored. A failed path is never in `removed`. A README or CODEOWNERS is compared by
 * blob SHA only: a path change with the same content counts as unchanged here, so the caller
 * updates the stored path from `file.path` either way.
 */
export async function syncBlobs(
  client: BlobClient,
  repo: BlobRepo,
  input: SyncBlobsInput,
  options: FetchOptions = {},
): Promise<SyncBlobsResult> {
  const diff = diffFiles(input.files, input.stored);
  const docs = [...diff.added, ...diff.modified].sort(byPath);

  const level = (file: PlannedFile | null | undefined, storedSha: string | null | undefined) => {
    if (!file) return { file: null, fetch: false };
    const entry: BlobFile = { path: file.path, blobSha: file.blobSha, size: file.size };
    const same = storedSha != null && storedSha.toLowerCase() === file.blobSha.toLowerCase();
    return { file: entry, fetch: !same };
  };
  const readme = level(input.repoLevel?.files.readme, input.repoLevel?.stored.readmeSha);
  const codeowners = level(
    input.repoLevel?.files.codeowners,
    input.repoLevel?.stored.codeownersSha,
  );

  // Repo-level files go last so the docs get the byte budget first. They are tracked by position,
  // not path, so they cannot be confused with a doc.
  const queue: BlobFile[] = [...docs];
  const readmeIndex = readme.fetch && readme.file ? queue.push(readme.file) - 1 : -1;
  const codeownersIndex =
    codeowners.fetch && codeowners.file ? queue.push(codeowners.file) - 1 : -1;

  const specDiff = input.apiSpecs ? diffFiles(input.apiSpecs.files, input.apiSpecs.stored) : null;
  const specQueue = specDiff
    ? [...specDiff.added, ...specDiff.modified]
        .sort(byPath)
        .map((f): BlobFile => ({ ...f, maxBytes: input.apiSpecs?.maxBytes }))
    : [];
  const specStart = queue.length;
  queue.push(...specQueue);

  const outcomes = await runFetch(client, repo, queue, options);
  const docResults = collect(outcomes.slice(0, docs.length));
  const specResults = collect(outcomes.slice(specStart));

  const finish = (
    entry: { file: BlobFile | null; fetch: boolean },
    index: number,
  ): RepoLevelResult => {
    if (entry.file === null) return { state: "absent" };
    if (!entry.fetch) return { state: "unchanged", file: entry.file };
    const outcome = outcomes[index] as Outcome;
    if ("ok" in outcome) {
      return {
        state: "fetched",
        file: entry.file,
        text: outcome.ok.text,
        warnings: outcome.ok.warnings,
      };
    }
    return { state: "failed", file: entry.file, kind: outcome.fail.kind };
  };

  return {
    ...diff,
    ...docResults,
    repoLevel: {
      readme: finish(readme, readmeIndex),
      codeowners: finish(codeowners, codeownersIndex),
    },
    apiSpecs: {
      ...specResults,
      unchanged: specDiff?.unchanged ?? [],
      removed: specDiff?.removed ?? [],
    },
  };
}
