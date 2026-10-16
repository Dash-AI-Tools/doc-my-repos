# Contributing to DocMyRepos

Thank you for helping. This guide gets you from a clone to a pull request. Please also read the [Code of Conduct](CODE_OF_CONDUCT.md). To report a vulnerability, do not open an issue: see [SECURITY.md](SECURITY.md).

For anything larger than a small fix, open an issue first so we can agree on the approach before you spend time on it.

## Set up

You need Node.js 24, [pnpm](https://pnpm.io) 11.25 and Docker (for Postgres). The repository has no `packageManager` field, so install pnpm yourself: `corepack enable && corepack prepare pnpm@11.25.0 --activate`.

```bash
git clone https://github.com/Dash-AI-Tools/doc-my-repos.git
cd doc-my-repos
pnpm install
cp .env.example .env     # DATABASE_URL already matches the compose database
pnpm db:up               # Postgres 17 on 127.0.0.1:5432
pnpm db:migrate
pnpm dev                 # http://localhost:3000
```

Syncing real repositories needs a GitHub App: see the [setup guide](docs/github-app-setup.md) and put its values in `.env`. You do not need one to work on most of the code: the tests and the end-to-end suite use fixtures and never contact GitHub.

## Commands

| Command                                | What it does                                                        |
| -------------------------------------- | ------------------------------------------------------------------- |
| `pnpm dev`                             | Run the app with hot reload                                         |
| `pnpm typecheck`                       | TypeScript, strict                                                  |
| `pnpm lint`                            | ESLint                                                              |
| `pnpm format:check` / `pnpm format`    | Prettier check / write (covers Markdown and YAML too)               |
| `pnpm test`                            | Unit and database tests (Vitest); needs Postgres                    |
| `pnpm test:e2e`                        | Browser tests (Playwright); needs Postgres and Chromium             |
| `pnpm build` / `pnpm build:migrate`    | Production build / the self-contained migration bundle              |
| `pnpm db:up`                           | Start only the compose `db` service                                 |
| `pnpm db:generate` / `pnpm db:migrate` | Create a Drizzle migration after a schema change / apply migrations |
| `pnpm screenshots`                     | Regenerate `docs-assets/screenshots` (light and dark)               |
| `openspec validate docmyrepos-mvp`     | Validate the specs (CLI: `npm i -g @fission-ai/openspec`)           |

Before you push, run `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`. CI runs the same, plus the build, the e2e tests, the Docker image and `openspec validate`.

## Test layers

Write a test with every parser or pipeline change.

1. **Unit tests** (`src/**/*.test.ts(x)`, `tests/unit/`): pure logic such as CODEOWNERS parsing, frontmatter, link rewriting, config validation, snippets, theme tokens. No database, no network.
2. **Database tests**: the sync engine, queries and search run against a **real Postgres**, never a mock. They create and drop a throwaway database on the server in `TEST_DATABASE_URL` (default `DATABASE_URL`, then the compose database) and fail loudly when it is unreachable. `SKIP_DB_TESTS=1` skips them, visibly. Use `describeDb` and `src/server/db/test-db.ts`.
3. **End-to-end tests** (`e2e/*.spec.ts`, Playwright + Chromium): real pages from a production build against a seeded throwaway database (`e2e/support/seed-data.ts`), including axe accessibility checks in light and dark. Setup once: `pnpm exec playwright install chromium` (add `--with-deps` on a fresh Linux machine). Then `pnpm db:up && pnpm test:e2e`. `E2E_SKIP_DB=1` runs only the specs that need no database. To cover new UI, add a seeded repository or documents to `seed-data.ts` and write the spec against them; keep existing names stable. Never set `E2E_FIXTURES` yourself: `playwright.config.ts` does it for its own server.
4. **CI smoke test** of the Docker image (`scripts/docker-smoke.sh`).

## How we work: specs first

The behavior of DocMyRepos is specified with [OpenSpec](https://github.com/Fission-AI/OpenSpec) under `openspec/changes/docmyrepos-mvp/`: `proposal.md`, one `specs/<capability>/spec.md` per capability (requirements with WHEN/THEN scenarios), `design.md` (decisions and trade-offs) and `tasks.md`.

- **A change in behavior starts in the spec.** Update the matching `specs/*/spec.md` first (and `design.md` if you change a decision), then the code, then run `openspec validate docmyrepos-mvp`. A pull request that changes behavior without its spec will be asked to add it.
- **Read the spec and the design decision before you implement** anything in that area.
- Bug fixes that restore specified behavior need a failing test first, not a spec change.

## Conventions

- **TypeScript strict**, no `any`. Match the style of the code around you; Prettier decides formatting, and `.editorconfig` covers the rest.
- **Layers.** Keep modules under `src/server/` free of React and under `src/components/` free of database access.
- **The visibility filter.** Every read of repos, documents, search, facets and assets goes through the single visibility filter in the shared query layer (`src/server/queries/`). Do not query those tables around it; a static guard test enforces this.
- **Pages read Postgres only.** Never call GitHub at request time, except the image proxy `/api/asset`.
- **Store parsed documents, not HTML.** Rendering happens at read time.
- **Syncs** are incremental (tree SHA, then blob SHA), idempotent and serialized per repository. A failed sync keeps the previously stored content.
- **Search** uses the generated weighted `tsvector` column and `websearch_to_tsquery`. Never build tsquery strings from user input by hand.
- **Config** is validated with zod; secrets come only from environment variables.
- **Both themes must work.** Check every UI change in light and dark (the e2e theme and accessibility specs help) and attach screenshots of both to the pull request.
- **OKF.** Only `type` is required in frontmatter and it is a free-form string: never hardcode a list of types and never normalize its case. Preserve and show unknown frontmatter keys. `index.md` and `log.md` are reserved and are not typed concepts. Tolerate missing fields and broken links.
- **Dependencies:** add them sparingly and keep `pnpm-lock.yaml` in the commit.

## Security rules

Documentation comes from third-party repositories and is untrusted.

- Sanitize rendered HTML after **all** rehype transforms. Never render `.mdx` as executable MDX.
- Mermaid runs with `securityLevel: 'strict'`.
- GitHub credentials (the App private key, installation tokens) never reach the browser, the logs or error messages. Wrap secrets (`Secret`), never log request bodies or error messages, and do not widen the logger's allowed fields. The App is read-only.
- `/api/asset` must validate that the path is inside a configured repository, serve only image content types and block path traversal.
- Verify webhook signatures against the raw request body. Guard `/api/sync` with `SYNC_SECRET`.
- Do not loosen the Content-Security-Policy (`src/lib/security-headers.ts`) without a reason written in the pull request. Never widen `default-src` or `script-src`.
- Never commit secrets. `.env`, `*.pem` and `.env.*` (except `.env.example`) are ignored.

## Commits and pull requests

- Keep a pull request focused on one change. Rebase on `main` rather than merging it in.
- **Commit messages:** a short imperative subject (about 70 characters), a blank line, then a body that explains **why** the change is needed and anything a reviewer must know. Reference the issue (`Fixes #123`). Small, logical commits are better than one large one.
- Fill in the pull request template. In short, a pull request is ready when:
  - the spec is updated for any behavior change and `openspec validate docmyrepos-mvp` passes;
  - tests are added or updated, and `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test` pass locally (and `pnpm test:e2e` for UI changes);
  - documentation is updated (README, `docs/` and `.env.example` for new settings);
  - UI changes come with screenshots in light and dark;
  - no secrets, no unrelated refactors.
- CI must be green. It cannot read repository secrets, so it also runs on pull requests from forks.

## Changing CI or Docker

- Actions in `.github/workflows` and `.github/actions` are pinned to full commit SHAs with the release in a comment; Dependabot (`.github/dependabot.yml`) opens the update pull requests. When you add an action, pin it the same way (`tests/unit/ci-hygiene.test.ts` enforces this, together with read-only permissions, job timeouts and no `pull_request_target`).
- Keep the Node and pnpm versions in `.github/actions/setup/action.yml` in step with the `Dockerfile` (`NODE_VERSION`, `PNPM_VERSION`).
- Run `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest` to lint workflow files.
- To try the image locally: `docker build -t docmyrepos:ci .` then `IMAGE=docmyrepos:ci DATABASE_URL=postgres://docmyrepos:docmyrepos@host.docker.internal:5432/<a scratch database> scripts/docker-smoke.sh` with `pnpm db:up` running.

## Documentation and screenshots

The README shows screenshots in light and dark, generated from the seeded e2e data. After a visible UI change run `pnpm screenshots` (needs `pnpm db:up` and Chromium) and commit the changed images in `docs-assets/screenshots/`. They are byte-for-byte reproducible, so unchanged pages produce no diff.

The `docs/` folder documents DocMyRepos itself in [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) so it can be synced into its own instance. Keep a `type` in the frontmatter of every document there.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
