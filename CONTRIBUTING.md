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
5. **Installer end-to-end test** (`scripts/installer-e2e.sh`): the built installer (`packages/create-docmyrepos`) runs non-interactively against a fake GitHub on a loopback port and the image you built, once per key layout, then checks health, the bootstrap admin's sign-in and the first sync request. Locally: `scripts/docker-build-labeled.sh` (builds `docmyrepos:dev`), `pnpm --filter create-docmyrepos build`, then `IMAGE=docmyrepos:dev scripts/installer-e2e.sh`. It needs Docker, Node 22.18 or newer, `openssl` and `curl`, and never contacts GitHub or a registry. `node scripts/check-pack.mjs` lists what npm would publish and fails on anything outside the allowed list.

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
  - documentation is updated (README, `docs/`, `.env.example` and `docmyrepos.config.example.yml` for new settings);
  - UI changes come with screenshots in light and dark;
  - no secrets, no unrelated refactors.
- CI must be green. It cannot read repository secrets, so it also runs on pull requests from forks.

## Changing CI or Docker

- Actions in `.github/workflows` and `.github/actions` are pinned to full commit SHAs with the release in a comment; Dependabot (`.github/dependabot.yml`) opens the update pull requests. When you add an action, pin it the same way (`tests/unit/ci-hygiene.test.ts` enforces this, together with read-only permissions, job timeouts and no `pull_request_target`).
- Keep the Node and pnpm versions in `.github/actions/setup/action.yml` in step with the `Dockerfile` (`NODE_VERSION`, `PNPM_VERSION`).
- Run `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest` to lint workflow files.
- To try the image locally: `docker build -t docmyrepos:ci .` then `IMAGE=docmyrepos:ci DATABASE_URL=postgres://docmyrepos:docmyrepos@host.docker.internal:5432/<a scratch database> scripts/docker-smoke.sh` with `pnpm db:up` running.

## Releasing

A release is a version tag. Pushing `vX.Y.Z` makes `.github/workflows/release.yml` publish two things with the same version number: the container image `ghcr.io/dash-ai-tools/doc-my-repos:X.Y.Z` (linux/amd64 and linux/arm64, with provenance and an SBOM) and the installer package `create-docmyrepos@X.Y.Z` on npm (with provenance). The installer pins the image of its own version, so the two must always be released together. Nothing is published from a fork, from a pull request or from a branch, and no long-lived secret is involved: the image uses the workflow's `GITHUB_TOKEN` and npm uses trusted publishing (OIDC).

### One-time setup

Do these once, in this order, before the first tag. You need to be an owner of the GitHub organization `Dash-AI-Tools` and to have (or create) an npm account.

1. **npm account with two-factor authentication.** On npmjs.com open _Account_ then _Two-Factor Authentication_ and enable it for _Authorization and publishing_. Use an authenticator app or a security key.
2. **Reserve the package name** (install-wizard task 1.2). Run `npm view create-docmyrepos`; a "404 Not Found" means the name is free. If it is taken, choose another `create-<name>`, change `name` in `packages/create-docmyrepos/package.json` and every `create-docmyrepos` in the docs, and record the new name below. If it is free, publish a placeholder so nobody else can take it and so the trusted publisher below can be configured:
   ```bash
   mkdir /tmp/reserve-create-docmyrepos && cd /tmp/reserve-create-docmyrepos
   printf '{ "name": "create-docmyrepos", "version": "0.0.0", "description": "Reserved for the DocMyRepos installer.", "license": "MIT" }\n' > package.json
   echo "Reserved for the DocMyRepos installer: https://github.com/Dash-AI-Tools/doc-my-repos" > README.md
   npm login          # the account from step 1
   npm publish --access public
   ```
   `0.0.0` is never a real release (real versions start at `0.1.0` and are published by the workflow). Record the owner here when it is done: **npm owner: not recorded yet. Fallback name if taken: none chosen.**
3. **Trusted publishing.** On npmjs.com open the package, then _Settings_, then _Trusted Publisher_, choose _GitHub Actions_ and enter organization `Dash-AI-Tools`, repository `doc-my-repos`, workflow filename `release.yml` and environment name `release`. Then, in the same settings page, set publishing access to _Require two-factor authentication and disallow tokens_. The workflow then publishes with a short-lived OIDC identity and no npm token is stored anywhere.
4. **The `release` environment.** In the repository open _Settings_, _Environments_, _New environment_, name it exactly `release`. Turn on _Required reviewers_ and add at least two maintainers (turn on _Prevent self-review_ if you have more than one). Under _Deployment branches and tags_ choose _Selected branches and tags_ and add the tag rule `v*.*.*`. Do not add secrets or variables to it.
5. **Allow public packages.** In the organization _Settings_, _Packages_, make sure members can create public packages. The image package is created private by its first publish.
6. **First release only: make the image public.** The first successful `image` job creates the package `doc-my-repos` under the organization as _private_. While the `npm` job is still waiting for approval (see below), open the organization's _Packages_, choose `doc-my-repos`, _Package settings_, _Change package visibility_, _Public_, and confirm. Check that _Manage Actions access_ lists this repository with the _Write_ role. Then check that anyone can pull: `docker logout ghcr.io && docker pull ghcr.io/dash-ai-tools/doc-my-repos:X.Y.Z`. Only then approve the `npm` job, so no user can install an installer whose image they cannot pull.

### Each release

1. **Choose the version** `X.Y.Z` (semantic versioning). For a rehearsal or a release candidate use a pre-release such as `0.1.0-rc.1`: npm publishes it under the `next` tag instead of `latest`, and the image is tagged with the exact version only. The workflow never writes a `latest` image tag.
2. **Bump both versions together.** Set `version` in `package.json` and in `packages/create-docmyrepos/package.json` to `X.Y.Z`, and run `node scripts/check-release-versions.mjs vX.Y.Z`; it must print "tag, root and installer versions agree". Open a pull request, get it green and merge it to `main`.
3. **Check locally** from the merged `main`: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`, then `scripts/docker-build-labeled.sh`, `pnpm --filter create-docmyrepos build` and `IMAGE=docmyrepos:dev scripts/installer-e2e.sh`.
4. **Tag and push** the commit you checked: `git checkout main && git pull && git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`. Tags are never moved or deleted afterwards.
5. **Watch the run** under _Actions_, _Release_. The `verify` job starts by itself: it checks the versions, runs lint, types, all tests, the browser tests, the pack check, builds the image and runs the installer against it. Nothing is published if it fails; fix forward with a new version.
6. **Approve.** The `image` job then waits for the `release` environment: a reviewer opens the run, chooses _Review deployments_, checks the tag and the commit, and approves. When the image is published, the `npm` job waits for the same approval. (On the first release do step 6 of the setup between the two approvals.) The `image` job fails on purpose if the image tag already exists; the `npm` job fails if npm already has that version.
7. **Verify the provenance.**
   - Image: `docker buildx imagetools inspect ghcr.io/dash-ai-tools/doc-my-repos:X.Y.Z` lists `linux/amd64` and `linux/arm64`. `gh attestation verify oci://ghcr.io/dash-ai-tools/doc-my-repos:X.Y.Z --repo Dash-AI-Tools/doc-my-repos` must succeed and name this repository, `release.yml` and the tagged commit. `docker pull` it and `docker inspect --format '{{json .Config.Labels}}'` shows the source, version, revision and licenses labels.
   - Package: the page `https://www.npmjs.com/package/create-docmyrepos/v/X.Y.Z` shows _Built and signed on GitHub Actions_ with the repository, workflow and commit, and `npm view create-docmyrepos@X.Y.Z dist.attestations` prints an attestations URL.
8. **Smoke-test on a clean machine** (no checkout of this repository, no earlier `docmyrepos` folder, Docker running), in an empty directory: `npx create-docmyrepos@X.Y.Z --version` prints `X.Y.Z`; `npx create-docmyrepos@X.Y.Z --dry-run` shows the plan with the image pinned to `X.Y.Z`; then run it for real against a throwaway organization, sign in with the admin you chose and watch the first sync finish at `/status`. Remove the test folder with `docker compose down -v`.
9. **Publish release notes** by creating a GitHub release from the tag (what changed, any migration or upgrade note).

### If a release goes wrong

- **Never** move or delete a version tag or an image tag, and do not unpublish an npm version: users may already have them. Deprecate instead.
- **A bad package or image:** deprecate the npm version so installs warn (`npm deprecate create-docmyrepos@X.Y.Z "Broken: use X.Y.Z+1"`), fix the problem, and release a patch version with the steps above. Users of the bad version move on by setting `DOCMYREPOS_VERSION` in their `.env` to the patch and running `docker compose pull && docker compose up -d --wait`.
- **The run failed before publishing** (`verify` red, approval declined): nothing is published. Fix on `main` and use the next version number, because the tag now points at a commit that did not pass.
- **The image was published but `npm` failed** (for example a trusted-publisher mismatch): fix the cause, then use _Re-run failed jobs_ on the same run; the image job is not repeated. If the commit itself must change, release the next patch version instead.
- **The `image` job failed halfway through the push:** the guard refuses a version tag that exists, so a retry of the same version fails. Release the next patch version.

### Checking the pipeline without releasing

`docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest` lints the workflows. `tests/unit/release-workflow.test.ts` checks their shape (trigger, repository guard, environment, permissions, labels). `node scripts/check-pack.mjs` checks the npm package contents. A real run needs a tag, so the first end-to-end proof of the pipeline is the pre-release described in step 1 of _Each release_.

## Documentation and screenshots

The README shows screenshots in light and dark, generated from the seeded e2e data. After a visible UI change run `pnpm screenshots` (needs `pnpm db:up` and Chromium) and commit the changed images in `docs-assets/screenshots/`. They are byte-for-byte reproducible, so unchanged pages produce no diff.

The `docs/` folder documents DocMyRepos itself in [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) so it can be synced into its own instance. Keep a `type` in the frontmatter of every document there.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
