import type { FrontmatterData, JsonValue } from "./frontmatter";

/** A stored document as far as OKF detection is concerned. */
export interface OkfDoc {
  /** Repo-relative path, the same form the tree uses (`docs/a/b.md`). */
  readonly path: string;
  readonly frontmatter: FrontmatterData | null | undefined;
}

export type ReservedKind = "index" | "log";

export interface OkfDetection {
  readonly isOkf: boolean;
  /** Why the repo is OKF. `type` wins over `okf_version` when both hold. Absent when not OKF. */
  readonly reason?: "type" | "okf_version";
  /** The root index's `okf_version` as a string, when it declares one. For display only. */
  readonly okfVersion?: string | null;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Which reserved file this is, or null. Matches the basename `index.md` or `log.md`, ignoring
 * case, at any depth (`index.md` summarizes every folder, so nested ones are reserved too).
 * Only `.md` counts: `index.mdx` is an ordinary document.
 */
export function reservedKind(path: string): ReservedKind | null {
  const name = basename(path).toLowerCase();
  if (name === "index.md") return "index";
  if (name === "log.md") return "log";
  return null;
}

export function isReservedFile(path: string): boolean {
  return reservedKind(path) !== null;
}

/**
 * True when the key `type` is present in the frontmatter, whatever its value. Presence is the
 * spec's test ("has a `type` key"), so `type:` (null), `type: ""` and `type: 3` all count; only
 * a missing key does not. Own keys only, so `__proto__`-style tricks cannot fake it.
 */
function hasTypeKey(frontmatter: FrontmatterData | null | undefined): boolean {
  return (
    frontmatter != null &&
    typeof frontmatter === "object" &&
    Object.prototype.hasOwnProperty.call(frontmatter, "type")
  );
}

/** A typed concept: has a `type` key and is not a reserved `index.md`/`log.md`. */
export function isTypedConcept(doc: OkfDoc): boolean {
  return !isReservedFile(doc.path) && hasTypeKey(doc.frontmatter);
}

function declaredVersion(value: JsonValue | undefined): string | null | undefined {
  // `undefined` means not declared. A bare `okf_version:` (null) is not a declaration.
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Arrays/objects declare something odd: still OKF, but there is no version to show.
  return null;
}

/**
 * Decides whether a repo is OKF. Pure. `docs` are the repo's stored documents with repo-relative
 * paths; `docsFolder` is what `findDocsFolder` returned (repo-relative, e.g. `docs`).
 *
 * - Any non-reserved doc with a `type` key makes it OKF (reason `type`). `okfVersion` is still
 *   reported when the docs-root index declares one, so the sync can store it either way.
 * - Otherwise the docs-root `index.md` (`<docsFolder>/index.md`, case-insensitive, never a nested
 *   index) declaring `okf_version` does (reason `okf_version`). Declaring means a non-null,
 *   non-blank value: a number such as `0.2` counts and is reported as "0.2".
 * - Docs outside `docsFolder` are ignored. A null docs folder means no docs, so not OKF.
 * - `type` values are never inspected, so case and content are irrelevant.
 */
export function detectOkf(docs: Iterable<OkfDoc>, docsFolder: string | null): OkfDetection {
  if (docsFolder == null) return { isOkf: false };
  const root = docsFolder.replace(/\/+$/, "").toLowerCase();
  const prefix = `${root}/`;
  let version: string | null | undefined;
  let typed = false;
  for (const doc of docs) {
    if (typeof doc?.path !== "string") continue;
    const lower = doc.path.toLowerCase();
    if (!lower.startsWith(prefix)) continue;
    if (isTypedConcept(doc)) typed = true;
    if (
      version === undefined &&
      reservedKind(doc.path) === "index" &&
      dirname(lower) === root &&
      doc.frontmatter != null &&
      Object.prototype.hasOwnProperty.call(doc.frontmatter, "okf_version")
    ) {
      version = declaredVersion(doc.frontmatter.okf_version);
    }
  }
  // Scan every doc so the root index's version is reported even when a typed doc decides first.
  const okfVersion = version;
  if (typed)
    return { isOkf: true, reason: "type", ...(okfVersion !== undefined && { okfVersion }) };
  if (version !== undefined) return { isOkf: true, reason: "okf_version", okfVersion: version };
  return { isOkf: false };
}
