/**
 * Constants of the comments e2e data (document-comments task 6.1). Plain data, no imports, like
 * `seed-data.ts`: the specs import them, `comment-seed.ts` writes them. The `comments` and
 * `commentsoff` servers are seeded with these users and comments on top of `SEED_REPOS`.
 *
 * The e2e servers run with E2E_AUTH_BYPASS; a request acts as a seeded user when it carries the
 * header `x-e2e-user: <email>` (see `getCurrentUser`). Without the header it is the fixed admin
 * that has no users row (it can read, but a write needs a row).
 */

export const COMMENT_USERS = {
  ana: { email: "ana@example.com", role: "user" },
  ben: { email: "ben@example.com", role: "user" },
  rita: { email: "rita@example.com", role: "user" },
  olga: { email: "olga@example.com", role: "admin" },
  otto: { email: "otto@example.com", role: "admin" },
  /** A 60-character local part: the display name is one unbroken word. */
  long: { email: `${"x".repeat(60)}@example.com`, role: "user" },
  /** Disabled by an admin: a request acting as her is signed out (tenant-context 5.3). */
  dora: { email: "dora@example.com", role: "user", disabled: true },
} as const;

export type CommentUser = keyof typeof COMMENT_USERS;

/** Documents of the comments data. Each scenario has its own so parallel specs do not meet. */
export const COMMENT_DOCS = {
  /** Starts with no comments: the post, reply, edit, delete, resolve and organization scenarios. */
  main: { owner: "acme", name: "api-service", githubId: 1001, path: "docs/guides/setup.md" },
  /** Starts with no comments: the 21st-comment scenario. */
  rate: {
    owner: "acme",
    name: "api-service",
    githubId: 1001,
    path: "docs/guides/advanced/tuning.md",
  },
  /** 50 threads with long names and unbroken words: the layout and axe checks. */
  heavy: {
    owner: "acme",
    name: "api-service",
    githubId: 1001,
    path: "docs/reference/endpoints.md",
  },
  /** Two comments: blocking the repository hides them. */
  blocked: { owner: "acme", name: "no-codeowners", githubId: 1009, path: "docs/guide.md" },
  /** Two comments (one a reply): the document is removed by a sync and restored. */
  synced: { owner: "acme", name: "no-readme", githubId: 1008, path: "docs/overview.md" },
} as const;

/** Orphans: a document that is gone (3 comments), a repository that is gone (2), and a kept one. */
export const ORPHANS = {
  document: { githubId: 1001, path: "docs/gone.md", count: 3 },
  repository: { githubId: 99999, path: "docs/old.md", count: 2 },
  /** Never purged by a spec: the layout and axe checks of the admin page need an orphan. */
  layout: { githubId: 1001, path: "docs/layout-gone.md", count: 2 },
} as const;

/** Number of threads on the heavy document. */
export const HEAVY_THREADS = 50;
