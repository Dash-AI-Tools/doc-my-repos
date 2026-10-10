/**
 * Safe URLs to GitHub for text that came from a third-party repository (task 9.5). Pure: no React,
 * no database, no server-only code.
 *
 * CODEOWNERS handles are untrusted. The sync stores a handle only when it matches the syntax of
 * `parseOwner` (`src/server/docs/codeowners.ts`), but this module does not rely on that: every
 * link is built from a handle that passes the strict pattern below, with each part percent-encoded,
 * and anything else yields `null` so the caller shows plain text. A handle can therefore never
 * produce a `javascript:` URL, a different host, a path traversal or a header-injection `mailto:`.
 */

/** GitHub user and organization logins (Enterprise Managed Users also carry `_`). */
const LOGIN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,38}$/;
/** Team slugs: alphanumerics, `-`, `_` and `.`. */
const TEAM_SLUG = /^[A-Za-z0-9_.-]{1,100}$/;
/**
 * Stricter than GitHub's own CODEOWNERS check: the characters of a plain mailbox. No quotes,
 * angle brackets, whitespace, `%` or `,`/`;` (a second recipient in a `mailto:`), no `?` or `&`
 * (query parameters such as `bcc=`).
 */
const EMAIL = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export type OwnerKind = "user" | "team" | "email";

export interface OwnerLink {
  readonly href: string;
  /** Whether the link leaves the portal for another site (`https:`), as opposed to `mailto:`. */
  readonly external: boolean;
}

/** A handle without its leading `@`. */
export function stripAt(handle: string): string {
  return handle.startsWith("@") ? handle.slice(1) : handle;
}

/**
 * The grouping key of an owner: GitHub logins and team slugs are case-insensitive and e-mail
 * domains are case-insensitive, so `@Alice` and `@alice` are one owner.
 */
export function ownerKey(handle: string): string {
  return handle.toLowerCase();
}

/**
 * Link target for an owner, or `null` when the handle is not valid for its kind:
 * - user `@alice`: `https://github.com/alice`
 * - team `@my-org/docs-team`: `https://github.com/orgs/my-org/teams/docs-team`
 * - e-mail `dev@example.com`: `mailto:dev@example.com`
 */
export function ownerLink(handle: string, kind: OwnerKind): OwnerLink | null {
  if (typeof handle !== "string") return null;
  if (kind === "user") {
    const login = stripAt(handle);
    if (!handle.startsWith("@") || !LOGIN.test(login)) return null;
    return { href: `https://github.com/${encodeURIComponent(login)}`, external: true };
  }
  if (kind === "team") {
    const [org, slug, ...rest] = stripAt(handle).split("/");
    if (!handle.startsWith("@") || rest.length > 0) return null;
    if (org === undefined || slug === undefined) return null;
    if (!LOGIN.test(org) || !TEAM_SLUG.test(slug) || slug === "." || slug === "..") return null;
    return {
      href: `https://github.com/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}`,
      external: true,
    };
  }
  if (kind === "email") {
    if (!EMAIL.test(handle)) return null;
    return { href: `mailto:${handle}`, external: false };
  }
  return null;
}

/**
 * The link to a repository on GitHub. `htmlUrl` is what GitHub reported at sync time; it is used
 * only when it is a plain `https:` URL without credentials (it may be a GitHub Enterprise host).
 * Otherwise the link is built from the owner and name on github.com, which are encoded.
 */
export function githubRepoUrl(
  htmlUrl: string | null | undefined,
  owner: string,
  name: string,
): string {
  if (typeof htmlUrl === "string" && htmlUrl.length <= 2048) {
    try {
      const url = new URL(htmlUrl);
      if (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.hostname !== ""
      ) {
        return url.href;
      }
    } catch {
      // fall through to the constructed URL
    }
  }
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}
