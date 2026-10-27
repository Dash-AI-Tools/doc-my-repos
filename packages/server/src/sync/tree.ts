import { createHash } from "node:crypto";
import {
  DEFAULT_DOCS_PATHS,
  DEFAULT_MAX_DOCS_PER_REPO,
  DEFAULT_MAX_FILE_BYTES as CONFIG_DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_SPEC_BYTES as CONFIG_DEFAULT_MAX_SPEC_BYTES,
  MAX_API_SPECS_PER_REPO,
} from "@docmyrepos/core/internal/config/schema";
import { pickCodeownersPath } from "../docs/codeowners-location";
import { findDocsFolder, normalizeDocsPath } from "../docs/docs-folder";
import { GitHubError, type CallOptions, type GitHubClient, type TreeEntry } from "../github/client";

/**
 * Tree planning: the first step of a repository sync (design decision on the sync engine).
 *
 * `planTree` reads the default-branch head and either short-circuits (nothing to do) or fetches the
 * recursive tree once and decides which files the sync needs: the Markdown docs under the docs
 * folder, the root README, and the CODEOWNERS file. It fetches no file contents; blob fetching and
 * diffing by blob SHA (task 5.5) and persistence (task 5.6) come after it.
 *
 * Short-circuit rule: the tree SHA alone is not enough, because a config change (docs folder
 * override, extensions, size cap, ignored folders) changes the selection without changing the
 * tree. So the plan is `unchanged` only when the tree SHA AND the selection fingerprint both equal
 * the stored ones. The caller persists `selectionFingerprint` next to `tree_sha` after a successful
 * sync, and must leave both untouched after a failed one.
 *
 * Failures:
 * - GitHub errors (including `not_found` on the branch head) are thrown as `GitHubError`; they are
 *   never turned into an empty plan, so the caller cannot mistake them for "no docs".
 * - A truncated recursive tree is `tree_truncated`, a typed outcome the caller records as a repo
 *   error while keeping the stored content. The design calls for one recursive tree call per repo,
 *   so there is no per-directory fallback; a partial tree is never planned from, because it would
 *   delete the docs the truncated listing left out.
 *
 * API specs (openapi-reference design decision 2): OpenAPI/Swagger candidates are selected beside
 * the docs, never counted in the document cap, and reported through `Selection.apiSpecs`. By
 * default a candidate is a file named `openapi` or `swagger` (any case) with `.yaml`, `.yml` or
 * `.json` at the repository root or below the docs folder; configured `apiSpecs` paths replace
 * that search. At most `MAX_API_SPECS_PER_REPO` are kept, in path order.
 *
 * Document cap (task 12.3): more docs than `maxFiles` does not fail the sync. The first `maxFiles`
 * files in path order (code unit order, so the same tree always keeps the same files) are
 * selected, the rest are reported as `over_limit` skips and `capped` is set. Documents stored
 * earlier that fall past the cap are not in the selection, so the sync removes them like any
 * file that left the docs folder: the portal shows exactly the capped set. The cap is part of the
 * selection fingerprint, so raising it re-plans every repo once.
 */

/**
 * Bump when the selection rules in this file change, so every repo is re-planned once. 2: the
 * document cap truncates instead of failing, and content syncs record `repos.sync_warnings`.
 * 3: OpenAPI/Swagger spec selection (`Selection.apiSpecs`) and the spec size limit.
 */
export const SELECTION_RULES_VERSION = 3;

/** Doc file extensions (spec: `.md`, `.mdx`), matched case-insensitively. */
export const DEFAULT_DOC_EXTENSIONS = [".md", ".mdx"] as const;
/**
 * Per-file size cap (design: 256 KB, well below the 1 MB tsvector limit). The config's
 * `limits.maxFileBytes` may lower it, never raise it.
 */
export const DEFAULT_MAX_FILE_BYTES = CONFIG_DEFAULT_MAX_FILE_BYTES;
/** Folder names skipped anywhere below the docs folder, matched case-insensitively. */
export const DEFAULT_IGNORED_FOLDERS = ["node_modules"] as const;
/** Most doc files planned for one repository; the rest are skipped `over_limit`. */
export const DEFAULT_MAX_FILES = DEFAULT_MAX_DOCS_PER_REPO;
/** Per-spec size cap (2 MB). The config's `limits.maxSpecBytes` may lower it, never raise it. */
export const DEFAULT_MAX_SPEC_BYTES = CONFIG_DEFAULT_MAX_SPEC_BYTES;
/** Most API specs kept for one repository; the rest are skipped `over_limit`. */
export const MAX_API_SPECS = MAX_API_SPECS_PER_REPO;
/** Default spec candidates: base name `openapi` or `swagger`, these extensions, any case. */
const API_SPEC_NAME_RE = /^(?:openapi|swagger)\.(?:ya?ml|json)$/i;
/** Longest accepted path; matches the GitHub client's own limit. */
const MAX_PATH_LENGTH = 1024;

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const CONTROL_RE_GLOBAL = /[\u0000-\u001f\u007f]/g;
/** Regular files only: symlinks (120000) and submodules (160000) are never read. */
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);
/** Root README names in order of preference; the spec stores the root README as Markdown. */
const README_EXTENSIONS = [".md", ".markdown", ".mdx", ""] as const;

export interface SelectionOptions {
  /** Per-repo `docsPath` override. Authoritative when set (no fallback to the defaults). */
  readonly docsPath?: string | null;
  /** `defaults.docsPaths` from the config. */
  readonly docsPaths?: readonly string[];
  readonly extensions?: readonly string[];
  readonly maxFileBytes?: number;
  /** Folder names to skip below the docs folder. When set it replaces the default list. */
  readonly ignoredFolders?: readonly string[];
  readonly maxFiles?: number;
  /**
   * Per-repo `apiSpecs` paths. When set (and non-empty) exactly these paths are considered instead
   * of the default search.
   */
  readonly apiSpecs?: readonly string[] | null;
  /** Per-spec size cap in bytes. */
  readonly maxSpecBytes?: number;
}

/** Options with defaults applied and values normalized, so equal settings fingerprint equally. */
interface ResolvedSelection {
  /** Normalized override; null when there is none. */
  docsPath: string | null;
  /** An override was set but is unusable: nothing is selected, with no fallback. */
  docsPathInvalid: boolean;
  docsPaths: string[];
  extensions: string[];
  maxFileBytes: number;
  ignoredFolders: string[];
  maxFiles: number;
  /** Sorted, de-duplicated, normalized configured paths; null when the default search applies. */
  apiSpecs: string[] | null;
  maxSpecBytes: number;
}

export interface PlannedFile {
  path: string;
  blobSha: string;
  size: number;
  mode: string;
}

export type SkipReason =
  /** Larger than `maxFileBytes`. */
  | "too_large"
  /** The tree did not report a size, so the cap cannot be checked before fetching. */
  | "size_unknown"
  /** Below an ignored folder such as `node_modules`. */
  | "ignored_folder"
  /** A dot-prefixed file or folder below the docs folder. */
  | "hidden"
  /** A symlink or submodule with a doc-like name. */
  | "not_regular_file"
  /** Traversal, empty segments, backslashes, control characters, or an over-long path. */
  | "invalid_path"
  /** The entry's object id is not a SHA. */
  | "invalid_entry"
  /** Past the per-repository document cap (`maxFiles`), in path order. */
  | "over_limit";

/** Why a spec candidate was not planned. Typed for the sync warnings. */
export type ApiSpecSkipReason =
  /** Larger than `maxSpecBytes`. */
  | "too_large"
  | "size_unknown"
  | "not_regular_file"
  | "invalid_path"
  | "invalid_entry"
  /** A configured path inside a dot-folder or dot-file. */
  | "hidden"
  /** A configured path below `node_modules` (or another ignored folder). */
  | "ignored_folder"
  /** Past the per-repository spec limit, in path order. */
  | "over_limit";

export interface SkippedApiSpec {
  /** Path as found, with control characters replaced so it is safe to store and display. */
  path: string;
  reason: ApiSpecSkipReason;
}

export interface ApiSpecSelection {
  /** At most `MAX_API_SPECS`, sorted by path (code unit order). */
  files: PlannedFile[];
  /** Sorted by path. Includes the `over_limit` ones. */
  skipped: SkippedApiSpec[];
  /** How many candidates past the limit were left out (the `over_limit` skips). */
  leftOut: number;
  /** True when configured `apiSpecs` paths were used instead of the default search. */
  configured: boolean;
}

export interface SkippedFile {
  /** Path as found, with control characters replaced so it is safe to store and display. */
  path: string;
  reason: SkipReason;
}

export interface RepoLevelFiles {
  /** Root README, or null when there is none (or it was skipped). */
  readme: PlannedFile | null;
  /** CODEOWNERS in GitHub's precedence, or null. */
  codeowners: PlannedFile | null;
}

export interface Selection {
  docsFolder: string | null;
  /** Sorted by path (code unit order), so plans are deterministic. */
  files: PlannedFile[];
  /** Sorted by path. Only files that would otherwise have been docs, README or CODEOWNERS. */
  skipped: SkippedFile[];
  repoLevelFiles: RepoLevelFiles;
  /** Set when more docs than `maxFiles` were found: how many, and the cap. */
  capped: { found: number; limit: number } | null;
  /** OpenAPI/Swagger candidates; independent of the document cap and of `files`. */
  apiSpecs: ApiSpecSelection;
}

const NO_API_SPECS: ApiSpecSelection = { files: [], skipped: [], leftOut: 0, configured: false };

/** Normalizes and validates options. Throws `TypeError` on a programming error (bad numbers). */
function resolveSelection(options: SelectionOptions): ResolvedSelection {
  const positiveInt = (value: number, name: string) => {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer`);
    }
    return value;
  };
  const extensions = [...(options.extensions ?? DEFAULT_DOC_EXTENSIONS)].map((e) => {
    const lower = e.trim().toLowerCase();
    if (!/^\.[a-z0-9]+$/.test(lower)) throw new TypeError("extensions must look like '.md'");
    return lower;
  });
  if (extensions.length === 0) throw new TypeError("extensions must not be empty");
  const ignoredFolders = [...(options.ignoredFolders ?? DEFAULT_IGNORED_FOLDERS)].map((f) => {
    const lower = f.trim().toLowerCase();
    if (lower === "" || lower.includes("/")) {
      throw new TypeError("ignoredFolders must be folder names");
    }
    return lower;
  });
  const docsPaths = (options.docsPaths ?? DEFAULT_DOCS_PATHS)
    .map((p) => normalizeDocsPath(p))
    .filter((p): p is string => p !== null);
  const docsPath = options.docsPath == null ? null : normalizeDocsPath(options.docsPath);
  const configuredSpecs =
    options.apiSpecs == null || options.apiSpecs.length === 0
      ? null
      : [
          ...new Set(
            options.apiSpecs.map(normalizeDocsPath).filter((p): p is string => p !== null),
          ),
        ].sort();
  return {
    apiSpecs: configuredSpecs,
    maxSpecBytes: positiveInt(options.maxSpecBytes ?? DEFAULT_MAX_SPEC_BYTES, "maxSpecBytes"),
    docsPath,
    docsPathInvalid: options.docsPath != null && docsPath === null,
    docsPaths,
    extensions: [...new Set(extensions)].sort(),
    maxFileBytes: positiveInt(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, "maxFileBytes"),
    ignoredFolders: [...new Set(ignoredFolders)].sort(),
    maxFiles: positiveInt(options.maxFiles ?? DEFAULT_MAX_FILES, "maxFiles"),
  };
}

/**
 * A stable hash of every input that affects which files are selected, plus the rules version.
 * Default lists and explicit lists with the same content hash the same; `docsPaths` order matters
 * (it is a preference order), extension and ignored-folder order does not.
 */
export function selectionFingerprint(options: SelectionOptions = {}): string {
  const r = resolveSelection(options);
  const canonical = JSON.stringify([
    SELECTION_RULES_VERSION,
    r.docsPath,
    r.docsPathInvalid,
    r.docsPaths,
    r.extensions,
    r.maxFileBytes,
    r.ignoredFolders,
    r.maxFiles,
    r.apiSpecs,
    r.maxSpecBytes,
    MAX_API_SPECS,
  ]);
  return `v${SELECTION_RULES_VERSION}:${createHash("sha256").update(canonical).digest("hex")}`;
}

function displayPath(path: string): string {
  return path.replace(CONTROL_RE_GLOBAL, "�");
}

/** True for a repo-relative path with no traversal, empty segments, backslashes or controls. */
export function isSafeTreePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (CONTROL_RE.test(path) || path.includes("\\")) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Picks the root README: `README.md`, then `.markdown`, `.mdx`, then no extension, matched
 * case-insensitively; exact `README` spelling first, else lexicographic.
 */
function pickReadme(candidates: TreeEntry[]): TreeEntry | null {
  for (const ext of README_EXTENSIONS) {
    const matches = candidates.filter((e) => e.path.toLowerCase() === `readme${ext}`);
    if (matches.length === 0) continue;
    const exact = matches.find((e) => e.path === `README${ext}`);
    return exact ?? [...matches].sort(byPath)[0] ?? null;
  }
  return null;
}

/**
 * Pure selection over a recursive tree listing. Never throws on odd entries: they are skipped,
 * and reported when they would otherwise have been selected.
 *
 * A doc is a regular-file blob below the docs folder, with an allowed extension, a valid SHA, a
 * safe path, a known size at or under the cap, and no ignored or dot-prefixed segment below the
 * docs folder. The README and CODEOWNERS follow the same file, path and size rules.
 */
export function selectDocFiles(
  entries: readonly TreeEntry[],
  options: SelectionOptions = {},
): Selection {
  const r = resolveSelection(options);
  const skipped: SkippedFile[] = [];
  const skip = (path: string, reason: SkipReason) =>
    skipped.push({ path: displayPath(path), reason });

  const safe = entries.filter((e) => isSafeTreePath(e.path));
  const docsFolder = r.docsPathInvalid
    ? null
    : findDocsFolder(
        safe.filter(
          (e) => e.type === "tree" || (e.type === "blob" && REGULAR_FILE_MODES.has(e.mode)),
        ),
        r.docsPath === null ? { defaults: r.docsPaths } : { docsPath: r.docsPath },
      );

  /** Shared checks for a candidate file; returns the planned file or records why not. */
  const rejection = (entry: TreeEntry): SkipReason | null => {
    if (!isSafeTreePath(entry.path)) return "invalid_path";
    if (entry.type !== "blob" || !REGULAR_FILE_MODES.has(entry.mode)) return "not_regular_file";
    if (typeof entry.sha !== "string" || !SHA_RE.test(entry.sha)) return "invalid_entry";
    if (entry.size === null || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      return "size_unknown";
    }
    if (entry.size > r.maxFileBytes) return "too_large";
    return null;
  };
  const accept = (entry: TreeEntry): PlannedFile | null => {
    const reason = rejection(entry);
    if (reason !== null) {
      skip(entry.path, reason);
      return null;
    }
    return { path: entry.path, blobSha: entry.sha, size: entry.size ?? 0, mode: entry.mode };
  };

  const files: PlannedFile[] = [];
  if (docsFolder !== null) {
    const prefix = `${docsFolder}/`;
    for (const entry of entries) {
      if (typeof entry.path !== "string" || entry.type === "tree") continue;
      if (!entry.path.startsWith(prefix)) continue;
      const rest = entry.path.slice(prefix.length).split("/");
      const name = rest[rest.length - 1] ?? "";
      if (!r.extensions.includes(extensionOf(name))) continue;
      if (!isSafeTreePath(entry.path)) {
        skip(entry.path, "invalid_path");
        continue;
      }
      if (rest.slice(0, -1).some((s) => r.ignoredFolders.includes(s.toLowerCase()))) {
        skip(entry.path, "ignored_folder");
        continue;
      }
      if (rest.some((s) => s.startsWith("."))) {
        skip(entry.path, "hidden");
        continue;
      }
      const planned = accept(entry);
      if (planned) files.push(planned);
    }
  }

  // README and CODEOWNERS: only regular files are candidates, so a symlinked CODEOWNERS is not
  // used (GitHub ignores it too). Path-sane entries only.
  const regular = safe.filter((e) => e.type === "blob" && REGULAR_FILE_MODES.has(e.mode));
  const readmeEntry = pickReadme(regular.filter((e) => !e.path.includes("/")));
  const codeownersPath = pickCodeownersPath(regular);
  const codeownersEntry =
    codeownersPath === null ? null : (regular.find((e) => e.path === codeownersPath) ?? null);

  const readme = readmeEntry ? accept(readmeEntry) : null;
  const codeowners = codeownersEntry ? accept(codeownersEntry) : null;

  const apiSpecs = selectApiSpecs(entries, docsFolder, r);

  files.sort(byPath);
  let capped: Selection["capped"] = null;
  if (files.length > r.maxFiles) {
    capped = { found: files.length, limit: r.maxFiles };
    for (const over of files.splice(r.maxFiles)) skip(over.path, "over_limit");
  }

  return {
    docsFolder,
    files,
    skipped: skipped.sort(byPath),
    repoLevelFiles: { readme, codeowners },
    capped,
    apiSpecs,
  };
}

/**
 * Picks the API spec files. Default search: regular-file blobs named `openapi`/`swagger` with an
 * allowed extension at the root or below the docs folder; `node_modules` and dot-folders are not
 * searched (silently, they are not candidates). Configured paths: exactly those that exist as
 * blobs, with the same size, symlink, SHA, traversal and hidden/ignored-folder rules, reported
 * when they fail. A missing configured path is not reported here. Then the first
 * `MAX_API_SPECS` in path order are kept and the rest are `over_limit`.
 */
function selectApiSpecs(
  entries: readonly TreeEntry[],
  docsFolder: string | null,
  r: ResolvedSelection,
): ApiSpecSelection {
  const skipped: SkippedApiSpec[] = [];
  const skip = (path: string, reason: ApiSpecSkipReason) =>
    skipped.push({ path: displayPath(path), reason });
  const candidates: PlannedFile[] = [];

  const consider = (entry: TreeEntry) => {
    if (!isSafeTreePath(entry.path)) return skip(entry.path, "invalid_path");
    if (entry.type !== "blob" || !REGULAR_FILE_MODES.has(entry.mode)) {
      return skip(entry.path, "not_regular_file");
    }
    if (typeof entry.sha !== "string" || !SHA_RE.test(entry.sha)) {
      return skip(entry.path, "invalid_entry");
    }
    if (entry.size === null || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      return skip(entry.path, "size_unknown");
    }
    if (entry.size > r.maxSpecBytes) return skip(entry.path, "too_large");
    candidates.push({
      path: entry.path,
      blobSha: entry.sha,
      size: entry.size,
      mode: entry.mode,
    });
  };

  const configured = r.apiSpecs !== null;
  if (r.apiSpecs !== null) {
    const wanted = new Set(r.apiSpecs);
    for (const entry of entries) {
      if (typeof entry.path !== "string" || entry.type === "tree" || !wanted.has(entry.path)) {
        continue;
      }
      const segments = entry.path.split("/");
      if (segments.slice(0, -1).some((s) => r.ignoredFolders.includes(s.toLowerCase()))) {
        skip(entry.path, "ignored_folder");
      } else if (segments.some((s) => s.startsWith("."))) {
        skip(entry.path, "hidden");
      } else consider(entry);
    }
  } else {
    const prefix = docsFolder === null ? null : `${docsFolder}/`;
    for (const entry of entries) {
      if (typeof entry.path !== "string" || entry.type === "tree") continue;
      const segments = entry.path.split("/");
      const name = segments[segments.length - 1] ?? "";
      if (!API_SPEC_NAME_RE.test(name)) continue;
      const atRoot = segments.length === 1;
      if (!atRoot) {
        if (prefix === null || !entry.path.startsWith(prefix)) continue;
        const below = segments.slice(prefix.split("/").length - 1, -1);
        if (below.some((s) => s.startsWith(".") || r.ignoredFolders.includes(s.toLowerCase()))) {
          continue;
        }
      }
      consider(entry);
    }
  }

  candidates.sort(byPath);
  const over = candidates.splice(MAX_API_SPECS);
  for (const file of over) skip(file.path, "over_limit");
  return { files: candidates, skipped: skipped.sort(byPath), leftOut: over.length, configured };
}

// ---------------------------------------------------------------------------------------------
// planTree

export type TreeClient = Pick<GitHubClient, "getBranchHead" | "getTree">;

export interface PlanRepo {
  owner: string;
  name: string;
  /** "" for an empty repository (GitHub reports no default branch). */
  defaultBranch: string;
  config: { docsPath?: string; apiSpecs?: readonly string[] };
}

/** What the last successful sync stored for this repo; all null for a first sync. */
export interface StoredTreeState {
  treeSha: string | null;
  selectionFingerprint: string | null;
  /** ETag of the branch-head response, if the caller keeps one. */
  headEtag?: string | null;
  commitSha?: string | null;
}

export interface PlanOptions extends CallOptions {
  /** Selection settings other than the per-repo override, which comes from `repo.config`. */
  selection?: Omit<SelectionOptions, "docsPath" | "apiSpecs">;
}

interface HeadState {
  treeSha: string;
  commitSha: string | null;
  headEtag: string | null;
  selectionFingerprint: string;
}

export type TreePlan =
  | ({ unchanged: true; outcome: "unchanged" } & HeadState)
  | ({
      unchanged: false;
      /** `no_docs`: no docs folder; still a successful sync showing README, owners, empty docs. */
      outcome: "changed" | "no_docs";
    } & HeadState &
      Selection)
  | ({
      unchanged: false;
      outcome: "failed";
      /** Recorded as the repo's error; stored content is kept. */
      reason: "tree_truncated";
    } & HeadState)
  | {
      /** The repository has no default branch (no commits). A successful, empty sync. */
      unchanged: false;
      outcome: "empty_repo";
      treeSha: null;
      commitSha: null;
      headEtag: null;
      selectionFingerprint: string;
      docsFolder: null;
      files: [];
      skipped: [];
      repoLevelFiles: { readme: null; codeowners: null };
      capped: null;
      apiSpecs: ApiSpecSelection;
    };

/**
 * Plans one repository's sync from its default-branch tree. Makes at most two GitHub calls (branch
 * head, recursive tree) and none at all past the head when the plan is `unchanged`.
 */
export async function planTree(
  client: TreeClient,
  repo: PlanRepo,
  stored: StoredTreeState,
  options: PlanOptions = {},
): Promise<TreePlan> {
  const { signal } = options;
  const selection: SelectionOptions = {
    ...options.selection,
    docsPath: repo.config.docsPath ?? null,
    apiSpecs: repo.config.apiSpecs ?? null,
  };
  const fingerprint = selectionFingerprint(selection);

  if (repo.defaultBranch === "") {
    return {
      unchanged: false,
      outcome: "empty_repo",
      treeSha: null,
      commitSha: null,
      headEtag: null,
      selectionFingerprint: fingerprint,
      docsFolder: null,
      files: [],
      skipped: [],
      repoLevelFiles: { readme: null, codeowners: null },
      capped: null,
      apiSpecs: NO_API_SPECS,
    };
  }

  // A 304 only tells us the head is what we stored, so only send the ETag when a tree SHA is stored.
  const etag = stored.treeSha && stored.headEtag ? stored.headEtag : undefined;
  const head = await client.getBranchHead(repo.owner, repo.name, repo.defaultBranch, {
    etag,
    signal,
  });

  let state: HeadState;
  if (head.notModified) {
    if (!stored.treeSha || !etag) throw new GitHubError("invalid_response", 304);
    state = {
      treeSha: stored.treeSha,
      commitSha: stored.commitSha ?? null,
      headEtag: etag,
      selectionFingerprint: fingerprint,
    };
  } else {
    state = {
      treeSha: head.data.treeSha,
      commitSha: head.data.commitSha,
      headEtag: head.etag,
      selectionFingerprint: fingerprint,
    };
  }

  if (state.treeSha === stored.treeSha && fingerprint === stored.selectionFingerprint) {
    return { unchanged: true, outcome: "unchanged", ...state };
  }

  const tree = await client.getTree(repo.owner, repo.name, state.treeSha, {
    recursive: true,
    signal,
  });
  if (tree.notModified) throw new GitHubError("invalid_response", 304);
  if (tree.data.truncated) {
    return { unchanged: false, outcome: "failed", reason: "tree_truncated", ...state };
  }

  const selected = selectDocFiles(tree.data.entries, selection);
  return {
    unchanged: false,
    outcome: selected.docsFolder === null ? "no_docs" : "changed",
    ...state,
    ...selected,
  };
}
