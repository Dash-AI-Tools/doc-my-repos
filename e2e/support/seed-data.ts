/**
 * The data the seeded e2e database holds (task 9.2). Plain data, no imports: specs read it to know
 * what to expect, `seed.ts` writes it through the real persistence path (`persistRepoSync`).
 *
 * To add data for a later task (9.3 to 9.7, 10.x, 11.x): append a repository here, or add
 * documents, a README or CODEOWNERS to an existing one, and have the spec import the constant. Keep
 * names stable: other specs depend on them. `githubId` must be unique.
 *
 * Contents at a glance (home grid order is owner, then name):
 *   acme/api-service       public, README, CODEOWNERS, 4 docs in 2 nested folders   (the "full" repo)
 *   acme/brand-new         public, pending: row exists, never synced, no content
 *   acme/flaky-service     public, last sync failed, still has stored content
 *   acme/internal-tools    private, README, 2 docs
 *   acme/knowledge-base    public, OKF (okf_version 0.2), typed concepts, index.md and log.md
 *   acme/long-description  public, 700-character description and a very long name
 *   globex/handbook        private and OKF (typed docs, no okf_version)
 *   acme/no-readme         public, NO README; CODEOWNERS with many patterns, case variants, an
 *                          email owner and an unowned pattern; 1 doc            (task 9.3 to 9.5)
 *   acme/no-codeowners     public, README, NO CODEOWNERS, 1 doc                  (task 9.3 to 9.5)
 *   acme/rich-readme       public, README with a mermaid diagram, code blocks, a link to a synced
 *                          doc, a broken link and an image; 1 doc                (task 9.4)
 *   acme/doc-showcase      public, 8 docs for the document page: a folder index with a description,
 *                          a doc with code, table, task list, footnote, image and diagram, a doc
 *                          with a long outline, a frontmatter title, odd characters in a file name
 *                          (task 9.6 and 9.7)
 *   acme/empty-docs        public, README, synced, NO docs                       (task 9.6 and 9.7)
 *   acme/search-lab        public, plain Markdown, 30 docs for the search page (task 10.3): a title
 *                          match, a heading match and body matches for "deployment", a
 *                          markup-heavy doc, a hostile frontmatter title, a "rate limit" doc and 25
 *                          "changelog" docs to fill several pages
 *
 * Search data (task 10.3). The word "deployment" (the spec's "Title outranks body") appears in:
 *   title (rank A)         search-lab "Deployment"
 *   heading (B)            search-lab "Operations" (## Deployment checks)
 *   description or tag (C) knowledge-base "Release pipeline" (tag deployment)
 *   body (D)               api-service "Setup", internal-tools "Deploys" (private),
 *                          knowledge-base "Rollback", "Terms", "Use Postgres", globex/handbook
 *                          "Release windows" (private OKF), search-lab "Markup showcase"
 * so a "deployment" search finds 10 documents in 5 repositories. OKF values among them: types
 * concept, Concept (a case variant, kept apart), Runbook, Decision, policy; statuses active (3),
 * deprecated, draft; tags infrastructure (2), deployment, glossary, oncall, database, release,
 * governance (7 tags: one more than the facet list shows before "Show more").
 */

export interface SeedDoc {
  /** Repo-relative path. */
  readonly path: string;
  /** Full file text, frontmatter included. */
  readonly text: string;
}

export interface SeedRepo {
  readonly githubId: number;
  readonly owner: string;
  readonly name: string;
  readonly description: string | null;
  readonly visibility: "public" | "private";
  /** `synced`: complete sync. `error`: complete sync, then marked failed. `pending`: never synced. */
  readonly state: "synced" | "error" | "pending";
  /** Docs folder of the stored documents. Default `docs`. */
  readonly docsFolder?: string;
  readonly readme?: string;
  readonly codeowners?: string;
  readonly docs?: readonly SeedDoc[];
  /** `repos.sync_error` for `state: "error"`: a text the real sync writes. */
  readonly syncError?: string;
  /** Fixed `repos.last_synced_at` (ISO 8601 UTC), so absolute times are stable. */
  readonly lastSyncedAt?: string;
}

const LONG_WORD =
  "ThisIsOneVeryLongUnbrokenTokenWithoutAnySpacesToCheckThatCardsDoNotOverflow".repeat(2);

const LONG_DESCRIPTION =
  `${"A deliberately long description that keeps going to check the three line clamp. ".repeat(8)}` +
  `${LONG_WORD} <img src=x onerror=alert(1)> and <b>markup</b> shown as plain text.`;

const RICH_README = [
  "# rich-readme",
  "",
  "A README with every feature the pipeline supports.",
  "",
  "## Architecture",
  "",
  "```mermaid",
  "graph TD",
  "  A[Client] --> B{Gateway}",
  "  B --> C[Service]",
  "```",
  "",
  "![Architecture overview](docs/assets/architecture.png)",
  "",
  "## Usage",
  "",
  "```ts",
  "export const answer: number = 42;",
  "```",
  "",
  "Read the [guide](docs/guide.md), the [missing page](docs/does-not-exist.md) or the",
  "[source file](src/index.ts).",
  "",
].join("\n");

const MARKUP_HEAVY = [
  "# Markup showcase",
  "",
  "Intro with **bold deployment notes**, a [deployment guide](https://example.com/deployment/guide),",
  '`deployment.yaml` inline code and <span class="x">inline html deployment</span> in a line.',
  "",
  "> **Note**",
  "> Quoted deployment advice.",
  "",
  "| Stage | Notes |",
  "| ----- | ----- |",
  "| build | deployment starts here |",
  "",
  "```bash",
  "./deploy --env production # deployment script",
  "```",
  "",
].join("\n");

const SHOWCASE_GETTING_STARTED = [
  "# Getting started",
  "",
  "Install the tool, then follow the checklist.[^1] See the [long outline](long-outline.md) and the",
  "[API reference](../reference/api.md).",
  "",
  "## Install",
  "",
  "```bash",
  "npm install docmyrepos",
  "```",
  "",
  "```ts",
  "export const answer: number = 42;",
  "```",
  "",
  "## Checklist",
  "",
  "- [x] Install the tool",
  "- [ ] Configure the GitHub App",
  "",
  "## Options",
  "",
  "| Option | Default |",
  "| ------ | ------- |",
  "| `docs` | `docs/` |",
  "| `port` | `3000`  |",
  "",
  "### Environment",
  "",
  "Set `DATABASE_URL` before the first start.",
  "",
  "## Architecture",
  "",
  "```mermaid",
  "graph TD",
  "  A[Client] --> B{Portal}",
  "  B --> C[(Postgres)]",
  "```",
  "",
  "![Architecture overview](../assets/architecture.png)",
  "",
  "[^1]: Footnotes are part of GitHub-flavoured Markdown.",
  "",
].join("\n");

const SHOWCASE_LONG_OUTLINE = [
  "# Long outline",
  "",
  ...Array.from({ length: 14 }, (_, i) => [
    `## Section ${i + 1}`,
    "",
    ...Array.from(
      { length: 6 },
      (_, j) => `Paragraph ${j + 1} of section ${i + 1}. `.repeat(12) + "\n",
    ),
    `### Detail ${i + 1}.1`,
    "",
    "Details for the section. ".repeat(20),
    "",
    `#### Note ${i + 1}.1.1`,
    "",
    "A short note.",
    "",
  ]).flat(),
].join("\n");

export const SEED_REPOS: readonly SeedRepo[] = [
  {
    githubId: 1001,
    owner: "acme",
    name: "api-service",
    description: "The public REST API of the platform.",
    visibility: "public",
    state: "synced",
    lastSyncedAt: "2026-03-14T09:30:00.000Z",
    readme:
      "# api-service\n\nThe public REST API.\n\n## Quick start\n\nRun `make dev`, then see the [setup guide](docs/guides/setup.md).\n",
    codeowners: "* @alice\n/docs/ @acme/docs-team\n",
    docs: [
      {
        path: "docs/index.md",
        text: "---\ntitle: API documentation\ndescription: Start here.\n---\n\n# API documentation\n\nWelcome to the API docs.\n",
      },
      {
        path: "docs/guides/setup.md",
        text: "# Setup\n\nInstall the dependencies and start the server. Production deployment is covered by the operations guide.\n\n```bash\nmake dev\n```\n",
      },
      {
        path: "docs/guides/advanced/tuning.md",
        text: "# Tuning\n\nIncrease the connection pool size under heavy load.\n",
      },
      {
        path: "docs/reference/endpoints.md",
        text: "# Endpoints\n\n| Method | Path |\n| ------ | ---- |\n| GET | /v1/items |\n",
      },
    ],
  },
  {
    githubId: 1002,
    owner: "acme",
    name: "brand-new",
    description: "Added to the GitHub App installation, not synced yet.",
    visibility: "public",
    state: "pending",
  },
  {
    githubId: 1003,
    owner: "acme",
    name: "flaky-service",
    description: "A service whose last sync failed.",
    visibility: "public",
    state: "error",
    syncError: "GitHub rate limit exhausted; retry later",
    lastSyncedAt: "2026-02-01T08:15:00.000Z",
    readme: "# flaky-service\n\nStored content from the last good sync.\n",
    docs: [
      { path: "docs/overview.md", text: "# Overview\n\nWhat this service does.\n" },
      { path: "docs/runbook.md", text: "# Runbook\n\nHow to restart it.\n" },
    ],
  },
  {
    githubId: 1004,
    owner: "acme",
    name: "internal-tools",
    description: "Private tooling for the platform team.",
    visibility: "private",
    state: "synced",
    lastSyncedAt: "2026-03-10T17:45:00.000Z",
    readme: "# internal-tools\n\nOnly for the platform team.\n",
    docs: [
      { path: "docs/onboarding.md", text: "# Onboarding\n\nGet access to the tools.\n" },
      {
        path: "docs/deploys.md",
        text: "# Deploys\n\nHow releases go out. Every deployment is announced in chat.\n",
      },
    ],
  },
  {
    githubId: 1005,
    owner: "acme",
    name: "knowledge-base",
    description: "Company knowledge in the Open Knowledge Format.",
    visibility: "public",
    state: "synced",
    lastSyncedAt: "2026-03-12T12:00:00.000Z",
    readme: "# knowledge-base\n\nAn OKF knowledge base.\n",
    docs: [
      {
        path: "docs/index.md",
        text: '---\nokf_version: "0.2"\ndescription: Entry point of the knowledge base.\n---\n\n# Knowledge base\n\nStart with the concepts.\n',
      },
      {
        path: "docs/concepts/billing.md",
        text: "---\ntype: concept\ntags: [finance, billing]\nstatus: active\ndescription: How billing works.\n---\n\n# Billing\n\nInvoices are issued monthly.\n",
      },
      {
        path: "docs/decisions/use-postgres.md",
        text: "---\ntype: Decision\ntags: [database]\nstatus: draft\ndescription: Why we chose Postgres.\n---\n\n# Use Postgres\n\nWe chose Postgres for search. The deployment uses a single instance.\n",
      },
      {
        path: "docs/concepts/release-pipeline.md",
        text: "---\ntype: concept\ntags: [infrastructure, deployment]\nstatus: active\ndescription: How code reaches production.\n---\n\n# Release pipeline\n\nEvery merge is built and promoted automatically.\n",
      },
      {
        path: "docs/runbooks/rollback.md",
        text: "---\ntype: Runbook\ntags: [infrastructure, oncall]\nstatus: deprecated\ndescription: Undo a bad release.\n---\n\n# Rollback\n\nRevert the last deployment with the rollback script.\n",
      },
      {
        path: "docs/glossary/terms.md",
        text: "---\ntype: Concept\ntags: [glossary]\nstatus: active\ndescription: Words used in this knowledge base.\n---\n\n# Terms\n\nA deployment is one release of the service.\n",
      },
      {
        path: "docs/log.md",
        text: "# Log\n\n## 2026-03-12\n\nAdded the billing concept.\n",
      },
    ],
  },
  {
    githubId: 1006,
    owner: "acme",
    name: "a-repository-with-a-really-long-name-for-layout-testing",
    description: LONG_DESCRIPTION,
    visibility: "public",
    state: "synced",
    lastSyncedAt: "2026-01-05T06:05:00.000Z",
    docs: [{ path: "docs/readme.md", text: "# Layout\n\nLong names must not overflow.\n" }],
  },
  {
    githubId: 1007,
    owner: "globex",
    name: "handbook",
    description: "Private company handbook, written as OKF concepts.",
    visibility: "private",
    state: "synced",
    lastSyncedAt: "2026-03-13T10:20:00.000Z",
    docs: [
      {
        path: "docs/policies/travel.md",
        text: "---\ntype: policy\ntags: [travel]\n---\n\n# Travel\n\nBook through the portal.\n",
      },
      {
        path: "docs/policies/release.md",
        text: "---\ntype: policy\ntags: [release, governance]\nstatus: active\n---\n\n# Release windows\n\nA deployment may only start on Tuesday or Thursday.\n",
      },
    ],
  },
  {
    githubId: 1008,
    owner: "acme",
    name: "no-readme",
    description: "A repository without a README.",
    visibility: "public",
    state: "synced",
    lastSyncedAt: "2026-03-01T10:00:00.000Z",
    codeowners: [
      "# Default owners",
      "* @bob @Acme/Platform",
      "/docs/ @Bob",
      "/SECURITY.md security@acme.example",
      "# Un-owned: no owners on the line",
      "/vendor/",
      ...Array.from({ length: 10 }, (_, i) => `/services/service-${i + 1}/ @carol`),
      "/a/very/long/path/with/many/segments/that/should/wrap/instead/of/stretching/the/panel/**/*.generated.ts @carol",
      "",
    ].join("\n"),
    docs: [{ path: "docs/overview.md", text: "# Overview\n\nA repository with no README.\n" }],
  },
  {
    githubId: 1009,
    owner: "acme",
    name: "no-codeowners",
    description: "A repository without a CODEOWNERS file.",
    visibility: "public",
    state: "synced",
    lastSyncedAt: "2026-03-02T11:30:00.000Z",
    readme: "# no-codeowners\n\nThis repository has a README but no CODEOWNERS file.\n",
    docs: [{ path: "docs/guide.md", text: "# Guide\n\nA guide.\n" }],
  },
  {
    githubId: 1010,
    owner: "acme",
    name: "rich-readme",
    description: "A README that uses everything the Markdown pipeline supports.",
    visibility: "public",
    state: "synced",
    lastSyncedAt: "2026-03-03T08:00:00.000Z",
    codeowners: "* @alice\n",
    readme: RICH_README,
    docs: [{ path: "docs/guide.md", text: "# Guide\n\nThe guide the README links to.\n" }],
  },
  {
    githubId: 1011,
    owner: "acme",
    name: "doc-showcase",
    description: "Documents that exercise the document page.",
    visibility: "public",
    state: "synced",
    lastSyncedAt: "2026-03-04T09:00:00.000Z",
    readme: "# doc-showcase\n\nSee the [getting started guide](docs/guides/getting-started.md).\n",
    docs: [
      { path: "docs/overview.md", text: "# Overview\n\nThe first page of the showcase.\n" },
      {
        path: "docs/guides/index.md",
        text: "---\ntitle: Guides\ndescription: How-to guides for operators.\n---\n\n# Guides\n\nPick a guide from the list.\n",
      },
      { path: "docs/guides/getting-started.md", text: SHOWCASE_GETTING_STARTED },
      { path: "docs/guides/long-outline.md", text: SHOWCASE_LONG_OUTLINE },
      {
        path: "docs/notes/custom-title.md",
        text: "---\ntitle: A custom title\ndescription: The title comes from the frontmatter.\n---\n\n# A different heading\n\n## Details\n\nBody of the note.\n",
      },
      { path: "docs/reference/api.md", text: "# API reference\n\n## Endpoints\n\nNone yet.\n" },
      {
        path: "docs/special/100% done.md",
        text: "# 100% done\n\nA file name with a space and a percent sign.\n",
      },
      {
        path: "docs/special/tail.md",
        text: "# Zzz last page\n\nThe last page in table-of-contents order.\n",
      },
    ],
  },
  {
    githubId: 1013,
    owner: "acme",
    name: "search-lab",
    description: "Documents that exercise the search page.",
    visibility: "public",
    state: "synced",
    lastSyncedAt: "2026-03-06T09:00:00.000Z",
    docs: [
      {
        path: "docs/deployment.md",
        text: "# Deployment\n\nShip the service to production with the release script.\n",
      },
      {
        path: "docs/guides/operations.md",
        text: "# Operations\n\nDay-to-day operations of the service.\n\n## Deployment checks\n\nRun the smoke tests after every release.\n",
      },
      { path: "docs/guides/markup-heavy.md", text: MARKUP_HEAVY },
      {
        path: "docs/guides/throttling.md",
        text: "# Throttling\n\nClients that exceed the rate limit receive HTTP 429 and must back off.\n",
      },
      {
        path: "docs/special/odd-title.md",
        text: "---\ntitle: '<script>window.__xss = 1</script> & \"quotes\" gateway'\n---\n\nThe gateway <script>window.__xss = 1</script> terminates TLS.\n",
      },
      ...Array.from({ length: 25 }, (_, i) => {
        const n = String(i + 1).padStart(2, "0");
        return {
          path: `docs/changelog/release-${n}.md`,
          text: `# Release ${n}\n\nThis release fixes bugs. See the changelog entry ${n} for details.\n`,
        };
      }),
    ],
  },
  {
    githubId: 1012,
    owner: "acme",
    name: "empty-docs",
    description: "Synced, but without any documentation files.",
    visibility: "public",
    state: "synced",
    lastSyncedAt: "2026-03-05T09:00:00.000Z",
    readme: "# empty-docs\n\nThis repository has a README and no docs folder.\n",
  },
];

/** Names used by specs. */
export const SEEDED = {
  full: { owner: "acme", name: "api-service" },
  pending: { owner: "acme", name: "brand-new" },
  errored: { owner: "acme", name: "flaky-service" },
  private: { owner: "acme", name: "internal-tools" },
  okf: { owner: "acme", name: "knowledge-base" },
  long: { owner: "acme", name: "a-repository-with-a-really-long-name-for-layout-testing" },
  privateOkf: { owner: "globex", name: "handbook" },
  noReadme: { owner: "acme", name: "no-readme" },
  noCodeowners: { owner: "acme", name: "no-codeowners" },
  richReadme: { owner: "acme", name: "rich-readme" },
  showcase: { owner: "acme", name: "doc-showcase" },
  emptyDocs: { owner: "acme", name: "empty-docs" },
  searchLab: { owner: "acme", name: "search-lab" },
} as const;

/** `owner/name` of every private seeded repository. */
export const SEEDED_PRIVATE: readonly string[] = SEED_REPOS.filter(
  (r) => r.visibility === "private",
).map((r) => `${r.owner}/${r.name}`);
