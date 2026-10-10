import type { Element, Root } from "hast";

import { DOC_EXTENSION, docUrl } from "../../lib/routes";
import { anchorId, BROKEN_LINK_CLASS, SLUG_ID, urlScheme } from "./sanitize";

/**
 * Link rewriting (task 7.4): a rehype plugin in the `linkRewrite` slot, running before the
 * sanitizer, plus the pure resolver behind it. No database, no network: the caller passes the
 * set of synced document paths. Images are handled by `images.ts` (task 7.5), which reuses the
 * path helpers exported here.
 *
 * Rules, in order, for the `href` of every `<a>` (Markdown links, reference links, autolinks
 * and raw HTML links all arrive as `a` elements; code is text, so it is never touched):
 *
 *  1. Left untouched (the sanitizer decides): empty or space-only, fragment-only `#x`,
 *     query-only `?x`, anything with a URL scheme (`https:`, `mailto:`, `tel:`, `javascript:`,
 *     `data:` ...), protocol-relative `//host`. A non-string or missing `href` is skipped.
 *  2. Broken (`reason: "invalid"`), never turned into a URL: a backslash anywhere (browsers read
 *     `\\host` and `/\host` as `//host`), any control character (NUL, tab, newline, DEL) or
 *     percent-decoded one, a malformed `%` escape, a decoded segment containing `/` or `\`
 *     (`%2f`, `%5c`), or a lone surrogate. Longer than 2048 characters is broken too
 *     (`too_long`).
 *  3. Query string: dropped (in-app pages and the GitHub fallback do not use it).
 *  4. Path: each segment is percent-decoded exactly once (`my%20doc.md`, `%2e%2e` as `..`),
 *     then `.` and `..` are normalized.
 *       - Relative paths resolve against the directory of the current document
 *         (`ctx.path`, repo-relative).
 *       - A path starting with `/` is bundle-root-absolute and resolves against the docs
 *         folder (`/tables/orders.md` is `<docsFolder>/tables/orders.md`). If that is not a
 *         synced document, the same path against the repository root is tried once, so
 *         GitHub-style `/docs/guides/setup.md` still works. With no docs folder it is the
 *         repository root.
 *       - Never above the root: `..` past the repository root (past the docs folder for
 *         bundle-root-absolute paths) is broken (`outside_root`), not clamped. No `..` survives
 *         into any output URL.
 *  5. A target is a *folder* when the link ends in `/`, ends in `.` or `..`, or resolves to the
 *     root. A folder, or a path whose last segment has no extension, resolves to the first
 *     synced `index.md`, `index.mdx`, `README.md`, `README.mdx` inside it, if any.
 *  6. A synced document (exact path, `.md`/`.mdx` alike) becomes the in-app URL from
 *     `docUrl` (`src/lib/routes.ts`), root-relative, each segment `encodeURIComponent`-ed.
 *     Case: Git paths are case-sensitive, so the exact path wins; if nothing matches exactly
 *     and exactly one synced path matches ignoring case, that one is used (it avoids a
 *     link that only breaks because of a typo in case). Two or more case-variants: no match.
 *  7. Anything else that is not a synced document falls back to GitHub:
 *     `https://github.com/{owner}/{repo}/blob/{branch}/{path}` (`tree` for folders), each
 *     segment encoded, branch segments included (`HEAD` if the branch is unknown). The
 *     exception is BROKEN (`missing_doc`): a `.md`/`.mdx` file inside the docs folder that is
 *     not synced. A Markdown file outside the docs tree (the README, `CHANGELOG.md`) is a
 *     plain repo file and goes to GitHub. A synced doc skipped by the sync (too large,
 *     dot-folder) also looks broken; that is the cost of not knowing the repo tree.
 *  8. Fragment: kept when it is a valid heading slug (SLUG_ID). For an in-app target it is
 *     lowercased (heading ids are github-slugger output) and passed through `anchorId`, so
 *     `#Constructor` becomes `#user-content-constructor`, exactly the id the sanitizer gives
 *     that heading. For a GitHub target it is kept as written (`#L10-L20`). Otherwise
 *     dropped; the link then goes to the page or file without an anchor.
 *
 * A broken link keeps its text but loses its `href` (it is no longer a link), gets
 * `class="dmr-broken-link"` and `title="Broken link: <original href>"` with control characters
 * removed and 120 characters at most. The page still renders; this never throws.
 */

/** Longest `href` that is resolved; a longer relative one is broken. */
export const MAX_HREF_CHARS = 2048;

/** Longest part of the original href shown in the broken-link `title`. */
export const MAX_BROKEN_TITLE_CHARS = 120;

/** Names tried, in order, when a link points at a folder. */
export const FOLDER_INDEX_NAMES = ["index.md", "index.mdx", "README.md", "README.mdx"] as const;

export interface LinkContext {
  /** Repository owner and name, for in-app and GitHub URLs. */
  readonly owner: string;
  readonly repo: string;
  /** Default branch for GitHub URLs. Empty means `HEAD`. */
  readonly defaultBranch: string;
  /** Docs folder in use (`repos.docs_path`), repo-relative, no slashes at the ends; or null. */
  readonly docsFolder: string | null;
  /** Repo-relative path of the document being rendered (`README.md` for the repo README). */
  readonly path: string;
  /**
   * Repo-relative paths of every synced document of this repository (`documents.path`).
   * Treated as immutable while the context is in use.
   */
  readonly docPaths: ReadonlySet<string>;
}

export type BrokenReason = "invalid" | "too_long" | "outside_root" | "missing_doc";

export type LinkResolution =
  | { readonly kind: "untouched" }
  | { readonly kind: "doc"; readonly href: string }
  | { readonly kind: "github"; readonly href: string }
  | { readonly kind: "broken"; readonly reason: BrokenReason };

const UNTOUCHED: LinkResolution = { kind: "untouched" };
/** A lone UTF-16 surrogate: not a valid character in a URL. */
export const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** C0 and C1 controls, DEL, and the line and paragraph separators. */
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function broken(reason: BrokenReason): LinkResolution {
  return { kind: "broken", reason };
}

/** `a/b/c.md` gives `a/b`; `c.md` gives the empty string. */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function splitPath(path: string): string[] {
  return path === "" ? [] : path.split("/");
}

/**
 * Applies decoded segments to `base`. `.` and empty segments are skipped; `..` pops but never
 * below `floor` base segments. Returns null when it would.
 */
export function normalize(
  base: readonly string[],
  segments: readonly string[],
  floor: number,
): string[] | null {
  const out = [...base];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length <= floor) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out;
}

/**
 * Percent-decodes one path segment, exactly once. Null for a malformed escape, or when the result
 * holds `/`, `\` or a control character.
 */
export function decodeSegment(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return /[/\\]/.test(decoded) || CONTROL.test(decoded) ? null : decoded;
}

function decodeFragment(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    return CONTROL.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

function lastSegmentHasExtension(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /.\.[^.]+$/.test(name);
}

function encodePath(path: string): string {
  return path === "" ? "" : path.split("/").map(encodeURIComponent).join("/");
}

/**
 * Builds a resolver bound to one context. The case-insensitive index is built on first use, so
 * build one per render, not per link.
 */
export function createLinkResolver(ctx: LinkContext): (href: string) => LinkResolution {
  let lower: Map<string, string[]> | null = null;

  const findIgnoringCase = (path: string): string | null => {
    if (lower === null) {
      lower = new Map();
      for (const p of ctx.docPaths) {
        const key = p.toLowerCase();
        const list = lower.get(key);
        if (list) list.push(p);
        else lower.set(key, [p]);
      }
    }
    const matches = lower.get(path.toLowerCase());
    return matches?.length === 1 ? (matches[0] ?? null) : null;
  };

  const findDoc = (path: string): string | null => {
    if (ctx.docPaths.has(path)) return path;
    return findIgnoringCase(path);
  };

  const lookup = (target: string, folder: boolean): string | null => {
    if (!folder) {
      const doc = DOC_EXTENSION.test(target) ? findDoc(target) : null;
      if (doc !== null) return doc;
    }
    if (folder || !lastSegmentHasExtension(target)) {
      const prefix = target === "" ? "" : `${target}/`;
      for (const name of FOLDER_INDEX_NAMES) {
        if (ctx.docPaths.has(prefix + name)) return prefix + name;
      }
      for (const name of FOLDER_INDEX_NAMES) {
        const found = findIgnoringCase(prefix + name);
        if (found !== null) return found;
      }
    }
    return null;
  };

  const inDocsTree = (target: string): boolean =>
    ctx.docsFolder !== null &&
    (target === ctx.docsFolder || target.startsWith(`${ctx.docsFolder}/`));

  const githubUrl = (target: string, folder: boolean, fragment: string | null): string => {
    const branch = encodePath(ctx.defaultBranch === "" ? "HEAD" : ctx.defaultBranch);
    const base = `https://github.com/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}`;
    const path = target === "" ? "" : `/${encodePath(target)}`;
    const hash =
      fragment !== null && SLUG_ID.test(fragment) ? `#${encodeURIComponent(fragment)}` : "";
    return `${base}/${folder ? "tree" : "blob"}/${branch}${path}${hash}`;
  };

  const resolveUnsafe = (href: string): LinkResolution => {
    const trimmed = href.replace(/^ +| +$/g, "");
    if (trimmed === "" || trimmed.startsWith("#")) return UNTOUCHED;
    if (urlScheme(trimmed) !== null || trimmed.startsWith("//")) return UNTOUCHED;
    if (trimmed.length > MAX_HREF_CHARS) return broken("too_long");
    if (CONTROL.test(trimmed) || LONE_SURROGATE.test(trimmed) || trimmed.includes("\\")) {
      return broken("invalid");
    }

    const hash = trimmed.indexOf("#");
    const beforeHash = hash === -1 ? trimmed : trimmed.slice(0, hash);
    const rawFragment = hash === -1 ? null : trimmed.slice(hash + 1);
    const query = beforeHash.indexOf("?");
    const rawPath = query === -1 ? beforeHash : beforeHash.slice(0, query);
    if (rawPath === "") return UNTOUCHED;

    const segments: string[] = [];
    for (const raw of rawPath.split("/")) {
      const decoded = decodeSegment(raw);
      if (decoded === null) return broken("invalid");
      segments.push(decoded);
    }
    const rootAbsolute = rawPath.startsWith("/");
    const last = segments[segments.length - 1];
    const folderSyntax = rawPath.endsWith("/") || last === "." || last === "..";

    const decodedFragment = rawFragment === null ? null : decodeFragment(rawFragment);
    const docFragment = (): string => {
      const slug = decodedFragment?.toLowerCase();
      return slug !== undefined && SLUG_ID.test(slug)
        ? `#${encodeURIComponent(anchorId(slug))}`
        : "";
    };
    const githubResult = (path: string, isFolder: boolean): LinkResolution => ({
      kind: "github",
      href: githubUrl(path, isFolder, decodedFragment),
    });
    const toDoc = (docPath: string): LinkResolution | null => {
      const url = docUrl(ctx.owner, ctx.repo, docPath, ctx.docsFolder);
      return url === null ? null : { kind: "doc", href: url + docFragment() };
    };

    let target: string;
    if (rootAbsolute) {
      const docsBase = splitPath(ctx.docsFolder ?? "");
      const underDocs = normalize(docsBase, segments, docsBase.length);
      if (underDocs === null) return broken("outside_root");
      target = underDocs.join("/");
      const isFolder = folderSyntax || target === "";
      const hit = lookup(target, isFolder);
      if (hit !== null) return toDoc(hit) ?? githubResult(hit, false);
      if (ctx.docsFolder !== null) {
        const fromRoot = normalize([], segments, 0)?.join("/");
        if (fromRoot !== undefined) {
          const rootHit = lookup(fromRoot, folderSyntax || fromRoot === "");
          if (rootHit !== null) return toDoc(rootHit) ?? githubResult(rootHit, false);
        }
      }
    } else {
      const resolved = normalize(splitPath(dirname(ctx.path)), segments, 0);
      if (resolved === null) return broken("outside_root");
      target = resolved.join("/");
      const hit = lookup(target, folderSyntax || target === "");
      if (hit !== null) return toDoc(hit) ?? githubResult(hit, false);
    }

    const folder = folderSyntax || target === "";
    if (!folder && DOC_EXTENSION.test(target) && inDocsTree(target)) return broken("missing_doc");
    return githubResult(target, folder);
  };

  return (href) => {
    try {
      return resolveUnsafe(href);
    } catch {
      return broken("invalid");
    }
  };
}

/** One-off resolution. Prefer `createLinkResolver` when resolving many links. */
export function resolveLink(href: string, ctx: LinkContext): LinkResolution {
  return createLinkResolver(ctx)(href);
}

/** `Broken link: <original href>`, control characters removed, length bounded. */
export function brokenLinkTitle(href: string): string {
  const shown = Array.from(
    href.slice(0, (MAX_BROKEN_TITLE_CHARS + 1) * 2).replace(new RegExp(CONTROL, "g"), ""),
  );
  const cut = shown.length > MAX_BROKEN_TITLE_CHARS;
  return `Broken link: ${shown.slice(0, MAX_BROKEN_TITLE_CHARS).join("")}${cut ? "…" : ""}`;
}

function applyBroken(node: Element, href: string): void {
  delete node.properties.href;
  node.properties.className = [BROKEN_LINK_CLASS];
  node.properties.title = brokenLinkTitle(href);
}

/**
 * Rehype plugin: rewrites `<a href>` as described at the top of this file. Use as
 * `slots.linkRewrite: [[rehypeRewriteLinks, context]]`, or pass `links` to `renderMarkdown`.
 * Walks iteratively, so tree depth cannot overflow the stack.
 */
export function rehypeRewriteLinks(options: LinkContext) {
  const resolve = createLinkResolver(options);
  return (tree: Root): undefined => {
    const stack: Root["children"] = [...tree.children].reverse();
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined || node.type !== "element") continue;
      if (node.tagName === "a") {
        const href = node.properties.href;
        if (typeof href === "string") {
          const result = resolve(href);
          if (result.kind === "doc" || result.kind === "github") node.properties.href = result.href;
          else if (result.kind === "broken") applyBroken(node, href);
        }
      }
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child !== undefined) stack.push(child);
      }
    }
    return undefined;
  };
}
