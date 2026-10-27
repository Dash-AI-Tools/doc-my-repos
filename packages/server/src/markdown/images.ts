import type { Element, Root } from "hast";

import { assetUrl } from "@docmyrepos/core/internal/routes";
import { imageTypeForPath } from "../assets/image-types";
import { isSafeAssetPath, MAX_ASSET_PATH_CHARS } from "../assets/path";
import {
  CONTROL,
  decodeSegment,
  dirname,
  LONE_SURROGATE,
  type LinkContext,
  MAX_HREF_CHARS,
  normalize,
  splitPath,
} from "./links";
import { urlScheme } from "./sanitize";

/**
 * Image rewriting (task 7.5): a rehype plugin in the `linkRewrite` slot, after
 * `rehypeRewriteLinks`, running before the sanitizer. No database, no network.
 *
 * Every `<img src>` is handled: Markdown images (inline and reference-style), images inside
 * links, and `<img>` written as raw HTML (rehype-raw has already turned it into an element).
 * Repository images become root-relative URLs of the image proxy,
 * `/api/asset/{owner}/{repo}/{repo-relative path}` (`assetUrl`), which fetches them from GitHub
 * server-side, so private repository images load without any credential reaching the browser.
 * The URL holds nothing else: no token, no ref, no query. The proxy always serves the default
 * branch, which is what the synced documents come from.
 *
 * Rules for the `src`, in order:
 *
 *  1. Left untouched: missing, not a string, empty or space-only; anything with a URL scheme;
 *     protocol-relative `//host`. External `http(s)` images therefore stay as written and the
 *     sanitizer keeps them (with `referrerpolicy="no-referrer"`). Privacy trade-off: the reader's
 *     browser then contacts that host directly, which learns the reader's IP address and that the
 *     image was viewed (not the page URL). Proxying third-party images would hide that but turn
 *     the proxy into an open fetcher, so it is not done. Other schemes (`data:`, `javascript:`)
 *     are left for the sanitizer, which removes them.
 *  2. Broken, `src` removed (the `alt` text stays, the browser shows no request): a backslash,
 *     a control character or lone surrogate (also percent-encoded), a malformed `%` escape, an
 *     encoded `/` or `\` (`%2f`, `%5c`), double encoding (`%252e`), a segment the proxy would
 *     refuse (`isSafeAssetSegment`: dot-only segments after Unicode normalization, `.git`,
 *     bidirectional controls), a `src` longer than 2048 characters or a resolved path longer
 *     than 1024; a `src` that is only `?query` or `#fragment`; a path that climbs above the
 *     repository root (above the docs folder for bundle-root-absolute paths), which is never
 *     clamped; a folder (`img/`, `.`); and a file whose extension the proxy does not serve
 *     (`image-types.ts`), since the proxy would refuse it anyway.
 *  3. Query and fragment are dropped (`logo.png?raw=true` is GitHub's raw link).
 *  4. Each segment is percent-decoded exactly once, then `.` and `..` are applied.
 *       - Relative (`./img/arch.png`, `../a.png`, `img/a.png`): against the directory of the
 *         current document (`ctx.path`, repo-relative).
 *       - Starting with `/`, in a document inside the docs folder: bundle-root-absolute, against
 *         the docs folder (`/img/a.png` is `<docsFolder>/img/a.png`). The link rewriter falls
 *         back to the repository root when the docs-root target is not a synced document; the
 *         set of image files is not known here, so the fallback is decided by the path: one that
 *         already starts with the docs folder (`/docs/img/a.png`, GitHub-style) is taken from the
 *         repository root.
 *       - Starting with `/` in a document outside the docs folder (the README), or with no docs
 *         folder: against the repository root, as GitHub renders it.
 *
 * Never throws: an unexpected failure marks the image broken.
 */

export type ImageBrokenReason =
  "invalid" | "too_long" | "outside_root" | "not_a_file" | "not_an_image";

export type ImageResolution =
  | { readonly kind: "untouched" }
  | { readonly kind: "asset"; readonly src: string; readonly path: string }
  | { readonly kind: "broken"; readonly reason: ImageBrokenReason };

const UNTOUCHED: ImageResolution = { kind: "untouched" };

function broken(reason: ImageBrokenReason): ImageResolution {
  return { kind: "broken", reason };
}

function startsWithSegments(segments: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.every((p, i) => segments[i] === p);
}

function resolveUnsafe(src: string, ctx: LinkContext): ImageResolution {
  const trimmed = src.replace(/^ +| +$/g, "");
  if (trimmed === "") return UNTOUCHED;
  if (urlScheme(trimmed) !== null || trimmed.startsWith("//")) return UNTOUCHED;
  if (trimmed.length > MAX_HREF_CHARS) return broken("too_long");
  if (CONTROL.test(trimmed) || LONE_SURROGATE.test(trimmed) || trimmed.includes("\\")) {
    return broken("invalid");
  }

  const end = trimmed.search(/[?#]/);
  const rawPath = end === -1 ? trimmed : trimmed.slice(0, end);
  if (rawPath === "") return broken("not_a_file");

  const segments: string[] = [];
  for (const raw of rawPath.split("/")) {
    const decoded = decodeSegment(raw);
    if (decoded === null) return broken("invalid");
    segments.push(decoded);
  }
  const last = segments[segments.length - 1];
  if (rawPath.endsWith("/") || last === "." || last === "..") return broken("not_a_file");

  let resolved: string[] | null;
  if (rawPath.startsWith("/")) {
    const docsBase = splitPath(ctx.docsFolder ?? "");
    const inDocs = ctx.docsFolder !== null && ctx.path.startsWith(`${ctx.docsFolder}/`);
    const named = segments.filter((s) => s !== "" && s !== ".");
    if (inDocs && !startsWithSegments(named, docsBase)) {
      resolved = normalize(docsBase, segments, docsBase.length);
    } else {
      resolved = normalize([], segments, 0);
    }
  } else {
    resolved = normalize(splitPath(dirname(ctx.path)), segments, 0);
  }
  if (resolved === null) return broken("outside_root");
  if (resolved.length === 0) return broken("not_a_file");

  const path = resolved.join("/");
  if (path.length > MAX_ASSET_PATH_CHARS) return broken("too_long");
  if (!isSafeAssetPath(path)) return broken("invalid");
  if (imageTypeForPath(path) === null) return broken("not_an_image");
  const url = assetUrl(ctx.owner, ctx.repo, path);
  return url === null ? broken("invalid") : { kind: "asset", src: url, path };
}

/** Resolves one image `src` against the document in `ctx`. Never throws. */
export function resolveImage(src: string, ctx: LinkContext): ImageResolution {
  try {
    return resolveUnsafe(src, ctx);
  } catch {
    return broken("invalid");
  }
}

function rewrite(node: Element, ctx: LinkContext): void {
  const src = node.properties.src;
  if (typeof src !== "string") return;
  const result = resolveImage(src, ctx);
  if (result.kind === "asset") node.properties.src = result.src;
  else if (result.kind === "broken") delete node.properties.src;
}

/**
 * Rehype plugin: rewrites `<img src>` as described at the top of this file. Use as
 * `slots.linkRewrite: [[rehypeRewriteImages, context]]` after `rehypeRewriteLinks`, or pass
 * `links` to `renderMarkdown`, which adds both. Walks iteratively, so tree depth cannot overflow
 * the stack.
 */
export function rehypeRewriteImages(options: LinkContext) {
  return (tree: Root): undefined => {
    const stack: Root["children"] = [...tree.children].reverse();
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined || node.type !== "element") continue;
      if (node.tagName === "img") rewrite(node, options);
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child !== undefined) stack.push(child);
      }
    }
    return undefined;
  };
}
