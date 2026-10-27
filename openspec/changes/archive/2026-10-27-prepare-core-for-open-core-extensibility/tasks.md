# Tasks

Every task leaves the app working. Unless a task says otherwise, "gates" means `pnpm typecheck && pnpm lint && pnpm test` green, plus the e2e specs named in the task. Documentation goes into `docs/reference/extension-api.md` (an OKF `Reference` doc, created in 1.4) unless another file is named.

## 1. Workspace and package skeletons

- [x] 1.1 Add `packages: ["packages/core", "packages/server", "packages/ui"]` to `pnpm-workspace.yaml`. Create the three package folders, each with:
  - a `package.json` (`@docmyrepos/core|server|ui`, version equal to the root, `type: module`, `exports` pointing at `src/*.ts`, and `publishConfig.exports` pointing at `dist`);
  - a `tsconfig.json`;
  - an empty `src/index.ts`.

  Add the three as `workspace:*` dependencies of the root app.

  Verify: `pnpm install --frozen-lockfile` succeeds after the lockfile update, and the gates pass.
- [x] 1.2 Teach the tooling about the packages:
  - `vitest.config.ts`: include `packages/*/src/**/*.test.{ts,tsx}`.
  - `eslint.config.mjs`: cover `packages/**`.
  - `next.config.ts`: `transpilePackages` for the three.
  - Root `tsconfig.json`: project references or path resolution.

  Verify: a throwaway `packages/core/src/smoke.test.ts` runs under `pnpm test` (delete it in the same task), and `pnpm build` succeeds.
- [x] 1.3 Update the `deps` stage of `Dockerfile` to copy `packages/*/package.json` before `pnpm install --frozen-lockfile`.

  Verify: `docker build -t docmyrepos:pkg .` succeeds, and `docker compose up -d --build --wait` reaches healthy with `/api/health` answering 200.
- [x] 1.4 Create `docs/reference/extension-api.md` (frontmatter `type: Reference`) with the package map and dependency direction `core ← server ← ui ← app`, and link it from `docs/reference/index.md`. Add ADR `docs/decisions/0005-host-app-composition.md` (Decision 1 of design.md) and list it in `docs/decisions/index.md`.

  Verify: the docs pass the repo's OKF validation (`pnpm test` covers `okf-validation`), and the links resolve.

## 2. Move the code into the packages (no behavior change)

- [x] 2.1 Move `src/lib/**` and `src/server/config/schema.ts` (pure zod, with its test) into `packages/core/src/` with `git mv`, keeping the subfolders. Rewrite their imports to relative paths, and rewrite every importer to `@docmyrepos/core/internal/*`.

  Verify: the gates pass, and `git log --follow` works on a moved file.
- [x] 2.2 Move `src/server/**` into `packages/server/src/` with `git mv`. Rewrite the `@/server` and `@/lib` imports with a codemod script kept under `scripts/`, and update `tests/stubs/server-only.ts` aliasing for the package tests. Update the path rules in `packages/server/src/queries/enforcement.test.ts` so the table-access guard keeps its meaning. Root `src/instrumentation.ts` and `src/proxy.ts` temporarily import `@docmyrepos/server/internal/*`.

  Verify: the gates pass, and `enforcement.test.ts` still fails when a test fixture outside the query layer reads `repos`.
- [x] 2.3 Move `src/components/**` into `packages/ui/src/components/`. Move the body of every `src/app/**/page.tsx`, `layout.tsx`, `error.tsx` and `not-found.tsx` into `packages/ui/src/pages/` as named components.

  The root route files keep their literal `dynamic`/`runtime`/`metadata` exports and re-export the component, while still calling the server modules directly. Keep `globals.css` working by importing `@docmyrepos/ui/styles.css`, which carries the `@source` for the package.

  Verify: the gates and `pnpm build` pass, the full `pnpm test:e2e` passes (axe in both themes included), and `pnpm screenshots` output is unchanged by visual check.
- [x] 2.4 Move the `next.config.ts` contents into `withDocMyRepos()` in `packages/server/src/next.ts`, exported as `@docmyrepos/server/next`, and make the root `next.config.ts` call it.

  Verify: `pnpm build`, the OpenAPI 3.1 reference e2e spec (no `refract` error) and `docker build` all pass.
- [x] 2.5 Make the root app's remaining files (`src/app/**`, `src/instrumentation.ts`, `src/proxy.ts`) import only package entrypoints. Add an ESLint `no-restricted-imports` rule that forbids `@/server`, `@/lib` and `@/components` everywhere.

  Verify: lint passes, and lint fails on a deliberately added `@/server/log` import (reverted).

## 3. Application factory and thin entrypoints

- [x] 3.1 In `@docmyrepos/core`, add the contract types: `TenantContext`, `User`, `Hooks`, the `Action`/`Resource`/`Feature` unions, the `DomainEvent` types and catalogue, the adapter interfaces, the `Plugin` and slot types, `EXTENSION_API_VERSION = 1`, `DEFAULT_TENANT` and `definePlugin`.

  Verify: unit tests for `definePlugin` validation (slug, `apiVersion`, job name prefix) and `DEFAULT_TENANT`.
- [x] 3.2 In `@docmyrepos/server`, add `loadConfig(env)`, which wraps `parseEnv`, the encryption-key check and the scheduler mode with unchanged messages. Add `createApp({ config, hooks, adapters, plugins })` with composition validation (duplicate or invalid ids, API major, duplicate job names, non-function hooks) and a single `globalThis` runtime registry. At this point the hooks and adapters are pass-through defaults over the current code.

  Verify: unit tests for each validation error, for "two `createApp` calls share one registry", and for `loadConfig` producing the same problems as `parseEnv` for the existing env fixtures.
- [x] 3.3 Implement `app.start()`, moving today's `register()` body: env checks, retired settings, `bootSyncScheduler`. Make root `src/instrumentation.ts` call `app.start()` from a new `src/docmyrepos.ts` (`export const app = createApp()`).

  Verify: the existing `schedule-runtime` tests pass through `app.start()`, a double `start()` boots one scheduler, and `docker compose up` logs the same start-up lines as before (compare the JSON event names).
- [x] 3.4 Expose `app.routes.<name>` for every core API route, bound to the existing `src/server` handlers, and rewrite all `src/app/api/**/route.ts` files to the thin form (literal segment config plus `export const { … } = app.routes.x`).

  Verify: the gates pass, a script-checked list shows identical path/method pairs before and after (`find src/app -name route.ts` plus exported methods), and the API e2e specs pass.
- [x] 3.5 Add `bindPage(Component, app)` in `@docmyrepos/ui/pages`, plus `app.pageContext()` (React `cache`, `headers()`). Make the proxy forward `x-dmr-pathname`, overwriting any client value. Rewrite every page and layout route file to `bindPage(…, app)`.

  Verify: the gates pass, a unit test shows a client-supplied `x-dmr-pathname` is replaced, and the full `pnpm test:e2e` passes.
- [x] 3.6 Add `createProxy({ publicPaths, isSignedIn })` at `@docmyrepos/server/proxy`, moving today's `src/proxy.ts` logic in unchanged. Make root `src/proxy.ts` export `createProxy()`. Add a test that the entrypoint's import graph contains no `node:` module, `pg`, `drizzle-orm` or `react`.

  Verify: the existing `proxy.test.ts` cases pass against `createProxy()`, and a new case shows an extra `publicPaths` entry bypasses the gate.
- [x] 3.7 Scaffold the contract suite: `tests/contract/` as a Vitest project (`pnpm test:contract`, also run by `pnpm test`), a `host.ts` that calls `createApp()` with defaults against a `createTestDatabase()`, and a static test that fails on any import that is not a public entrypoint.

  Verify: the suite passes with one test (`GET /api/health` through `app.routes.health` answers 200), and the static test fails on a deliberate `internal/` import (reverted).
- [x] 3.8 Document `createApp`, `app.start`, the routes and page bindings, `createProxy`, `withDocMyRepos` and the thin-file pattern, with a complete minimal host app example.

  Verify: the example's code blocks are copied into a type-checked fixture under `tests/contract/docs-examples/`, and they compile.

## 4. Tenant context and database adapter

- [x] 4.1 Implement `RequestContext` (`tenant`, `log`, `db()`, `workspace()`), the default `resolveTenant`/`listTenants` (the built-in tenant), and the default `DatabaseAdapter` (`getDb()` for `default`, a `ConfigError` otherwise). Make `app.context(request)` answer 404 with a generic body when `resolveTenant` returns null, before anything else runs. The log child adds `tenant` only for tenants other than `default`.

  Verify: unit tests for the 404 path (no adapter call), for the default adapter refusing tenant `x`, and that log output for `default` is byte-identical to `logger` output.
- [x] 4.2 Thread `ctx` through the read paths: replace the `getDb()` fallbacks in the page loaders (`home`, `repo-page`, `doc-page`, `doc-comments`, `search-page`, `search-api`, `status-page`, `status-api`, `health-api`, `api-reference-page`, `ask-page`, `toc-data`, `nav-view`, `onboarding`), the `branding` reads and the `assets` service with `ctx.db()`.

  Verify: the existing loader tests pass with `ctx` built over the test database, `grep -rn "getDb()" packages/server/src` lists only the default database adapter and scripts, and the e2e specs pass.
- [x] 4.3 Thread `ctx` through the write paths: `admin/*`, `comments/*`, `mcp/*`, `ask/*`, `auth/*`, `settings/*` and `sync/manual-sync`.

  Verify: the existing handler tests pass with `ctx`, and the `getDb()` grep result is unchanged from 4.2.
- [x] 4.4 Make the workspace cache per tenant: a bounded map in the registry, `invalidateWorkspace(tenant)`, and the same version re-check and stale-on-error rules.

  Verify: new tests show two tenants over two test databases with independent versions, and that a save in tenant `a` leaves tenant `b`'s cached workspace untouched. The existing `workspace.test.ts` passes.
- [x] 4.5 Partition the in-process state:
  - asset cache key `tenantId/githubId/branch/path`;
  - `askGate` and MCP limiter keys `tenantId:id`.

  The asset fetch gate and the search/status counters stay shared.

  Verify: unit tests show the same user id in two tenants does not block Ask, and the same asset path in two tenants yields two cache entries.
- [x] 4.6 Contract tests: tenant `a` and tenant `b` on two databases through a header-based `resolveTenant` stub. Seed different repositories, then assert that home, search and a document page each show only their own tenant's data, and that an unknown tenant gets 404. Document `TenantContext`, the database adapter and the partitioning rules.

  Verify: `pnpm test:contract` passes.

## 5. Authentication hook and tenant-bound sessions

- [x] 5.1 Implement the default `authenticate(request, tenant)` from `getCurrentUser`'s rules, taking the request explicitly, and expose `ctx.user()` memoized per request. Keep the `E2E_AUTH_BYPASS` behavior inside the default.

  Verify: the existing `current-user` tests pass against the hook, and a test shows one database lookup per request however many times `ctx.user()` is called.
- [x] 5.2 Add the optional session claim `tid`: written only for tenants other than `default`, and on verification `tid` must equal `tenant.id` (missing means `default`). Export `issueSession(ctx, user)`.

  Verify: unit tests show a `default` cookie is byte-identical in format to the previous release's, a tenant `a` cookie is refused under tenant `b`, and a cookie with no `tid` is refused under tenant `a`.
- [x] 5.3 Make every gated page and API confirm the user through `ctx.user()`: home, repo, docs, api-reference, search, status, ask, account pages, `/api/search`, `/api/status`, `/api/asset` and every `/api/admin/*`. A null user redirects pages to `/login` and answers 401 on APIs.

  Verify: a new e2e spec shows a user disabled after sign-in is redirected from a document page and gets 401 from `/api/search`, and the existing e2e suite passes.
- [x] 5.4 Route the MCP token check through the authentication path for `/api/mcp`, with the existing rules and the token looked up in the tenant's database.

  Verify: the existing MCP endpoint tests pass, and a contract test shows a token from tenant `a` is rejected under tenant `b`.
- [x] 5.5 Contract tests: a stub `authenticate` returns a fixed user for a custom header, and pages and APIs accept it. A cookie replayed across tenants is refused. A throwing `authenticate` yields a signed-out response and a `hook.failed` log. Update `access-control` docs (`docs/architecture/security.md`) for the Node-side check and tenant binding.

  Verify: `pnpm test:contract` passes.

## 6. Authorization hook

- [x] 6.1 Implement `defaultAuthorize` in core with the action table from design Decision 4, plus `ctx.can()` with the fail-closed wrapper.

  Verify: table-driven unit tests cover every action against admin, author, other user and an organization comment, matching today's rules.
- [x] 6.2 Replace the inline admin checks with `ctx.can("admin.manage")`, keeping each one's HTTP behavior: `requireAdmin`, `guard()`, `adminOrDenied`, `app/admin/layout` (in the ui page), `loadAllTokenRows`, `loadModeration`, `getAdmin*` and `onboarding`.

  Verify: the existing admin tests and e2e specs pass, and `grep -rn 'role === "admin"\|role !== "admin"' packages/server/src packages/ui/src` lists only `defaultAuthorize` and tests.
- [x] 6.3 Replace the comment, token and Ask checks (`mayModify`, resolve, `asOrganization`, author emails, the `token-api` modes, `requireUser` in Ask) with `ctx.can(...)`. Pass server-computed permissions (`canEdit`, `canResolve`, `canDelete`, admin items) to `comment-item` and `account-menu` instead of the role.

  Verify: the existing comments, tokens and Ask tests pass, the comment e2e specs pass, and the client components no longer read `role`.
- [x] 6.4 Keep the user-management invariants after `can()`, and keep visibility on the filter.

  Verify: a test with an allow-all `authorize` still gets 409 for last-admin demotion.
- [x] 6.5 Contract tests: a deny-list `authorize` blocks `comment.create` (403, nothing stored) and `admin.manage` ("Access denied"), and a throwing `authorize` denies. Document the action catalogue and resources.

  Verify: `pnpm test:contract` passes.

## 7. Entitlement hook

- [x] 7.1 Add `ctx.entitled(feature)` with the default always true and fail closed. Fold it into `getAskState`, `mcpEnabled` and `commentsEnabled` as `setting && entitled`.

  Verify: unit tests show each switch off when the setting is on and the entitlement is denied, and unchanged otherwise.
- [x] 7.2 Contract tests: denying `ask` makes `/ask` 404, hides the launcher slot data and gives `POST /api/ask` the "off" answer, while the stored settings stay unchanged. Denying `mcp` and `comments` behaves like the admin switch. Document the features and the "denied equals off" rule.

  Verify: `pnpm test:contract` passes.

## 8. Domain events

- [x] 8.1 Implement `ctx.emit()` (stamping, detached delivery, the `hook.failed` log on error) and the event payload types in core.

  Verify: unit tests show a throwing or hanging `onEvent` does not delay or change the caller's result, and that only the event name is logged.
- [x] 8.2 Emit `sync.completed` and `sync.failed` from the sync engine after each repository's sync is decided, with counts only.

  Verify: engine tests record one event per repository sync with the expected counts.
- [x] 8.3 Emit the auth, user, token, settings, branding, `repo.access_changed` and comment events at their handlers, after commit.

  Verify: handler tests record each event exactly once on success and none on a refused or failed request.
- [x] 8.4 Emit `search.performed` (result count, no query), `ask.answered` (token counts, provider, no content) and `mcp.tool_called` (tool name, outcome).

  Verify: a sentinel test feeds marker strings through search, Ask and MCP, and asserts that no event contains them.
- [x] 8.5 Contract test: a recording `onEvent` receives every name in the exported catalogue at least once, and nothing outside it. Document the catalogue, payloads and delivery semantics.

  Verify: `pnpm test:contract` passes.

## 9. Secrets, blob storage and email adapters

- [x] 9.1 Add `SecretsAdapter` with the env-key default, and route `createWorkspace`, `admin/settings` (save and GitHub test) and `app.start()` through it.

  Verify: `grep -rn SETTINGS_ENCRYPTION_KEY packages/server/src` lists only the default adapter and `loadConfig`. A test decrypts secrets written by the previous code path with the same key, and the existing settings tests pass.
- [x] 9.2 Add `BlobStore` with the default mapping `branding/logo` to the `site_branding` columns, and route logo upload, read and delete through it. Keep `logoVersion` in the row.

  Verify: the existing branding tests pass, a test reads a logo row written by the previous code, and the branding e2e spec passes.
- [x] 9.3 Add `EmailAdapter` with the rejecting default, exposed on the plugin context.

  Verify: a unit test shows the default rejects with `EmailNotConfiguredError`.
- [x] 9.4 Contract tests: a stub secrets adapter with a per-tenant key encrypts and decrypts independently for tenants `a` and `b`, an in-memory blob store receives the logo upload, and a recording email adapter receives a message sent through the plugin context. Document the three adapters, including "startup secrets stay in env".

  Verify: `pnpm test:contract` passes.

## 10. Jobs adapter and per-tenant background work

- [x] 10.1 Add the job registry, `app.jobs.run(job)` (unknown name rejects, the tenant comes from `payload.tenantId`) and the in-process default `JobsAdapter` over the existing background task set. Register `sync.full`, `sync.repo`, `sync.drain`, `sync.reap` and `webhook.dispatch`.

  Verify: unit tests for unknown jobs and for tenant resolution from the payload.
- [x] 10.2 Make the scheduler submit jobs instead of calling functions, with one loop per tenant from `listTenants()`, reconciled on each drain tick and failing per tenant independently. Keep the timings, jitter, startup delay, try-lock and SIGTERM behavior.

  Verify: the existing `scheduler`/`schedule-runtime` tests pass. New tests cover two tenants, adding and removing a tenant within one drain tick, and one tenant's database failure not stopping the other.
- [x] 10.3 Resolve webhooks to a tenant with `resolveTenant` (on a clone of the request), verify with that tenant's secret, and dispatch through `webhook.dispatch`. Keep the 5 s wait-then-202 when the adapter returns `done`, and answer 202 at once otherwise.

  Verify: the existing webhook tests pass, plus new tests for an installation mismatch (acknowledged, no sync) and a queue adapter (immediate 202).
- [x] 10.4 Contract tests: a queue jobs adapter collects the jobs submitted by a webhook and by the scheduler, and the test drains them with `app.jobs.run`. The sync lands in the right tenant database, and a duplicate concurrent `sync.repo` coalesces with the stored state equal to one run. Update ADR 0002's consequences and `docs/architecture/sync-engine.md` for the jobs adapter.

  Verify: `pnpm test:contract` passes.

## 11. Plugin API

- [x] 11.1 Add the plugin registry in `createApp` (ids, `apiVersion`, job namespace) and a plugin context (`ctx` plus `adapters.email`, `adapters.blobs`, `adapters.jobs`).

  Verify: unit tests for each rejection, and for a minimal plugin changing nothing.
- [x] 11.2 Add the catch-all `src/app/api/plugins/[plugin]/[...path]/route.ts` and the dispatcher: 404 or 405 before plugin code, the session requirement, `public/` routes declared only, and `requireSameOrigin` for unsafe methods unless `machine: true`. Add the proxy pass-through for `^/api/plugins/[^/]+/public(/|$)`.

  Verify: unit tests for each dispatch outcome, and the proxy tests for public and private plugin paths.
- [x] 11.3 Add the catch-all `src/app/-/[plugin]/[[...path]]/page.tsx`, page dispatch with the same rules, and the proxy pass-through for `^/-/[^/]+/public(/|$)`. Add `-` to `RESERVED_OWNERS`.

  Verify: an e2e spec with a fixture plugin, enabled only by the e2e app module, renders `/-/fixture/hello` inside the layout in both themes with axe clean. `/-/fixture/public/hi` renders signed out, and the `[owner]/[repo]` routes are unaffected.
- [x] 11.4 Add plugin jobs and schedules: they register through the job registry, and the scheduler runs schedules per listed tenant with the same enablement. A failing job is logged and isolated.

  Verify: scheduler tests with a fake clock run a plugin schedule for two tenants, and a throwing plugin job leaves the sync jobs running.
- [x] 11.5 Add plugin migrations to `migrateDatabase(url, { plugins })`: core first, then each plugin in schema `plugin_<id>` with its own journal, one transaction per plugin, and the core-schema fingerprint check with rollback. `scripts/db-migrate.ts` passes no plugins.

  Verify: database tests apply a two-file fixture migration once (a second run applies nothing). A fixture migration that runs `ALTER TABLE public.repos …` is rolled back and fails naming the plugin. `pnpm db:migrate` and the container entrypoint output are unchanged.
- [x] 11.6 Add the slot registry and `app.slots.resolve`. Register the core items as the first contributions:
  - header nav (Repositories, Ask);
  - account menu (today's admin links, tokens, agent access);
  - admin sections (today's admin home list);
  - workspace tabs (github, repos, folders, ask);
  - footer links (Sync status).

  Render `SiteHeader`, `AccountMenu`, the admin home, the workspace page and `SiteFooter` from the resolved slots, and add the `layout.banner` slot above `<main>`. A throwing contribution is dropped with a `plugin.failed` warning.

  Verify: unit tests show the resolved core items equal today's lists in order. The header, account menu, admin and footer e2e specs pass unchanged, and screenshots are unchanged.
- [x] 11.7 Build the sample plugin package `tests/contract/sample-plugin` (public imports only). It has a private and a public route, a private and a public page, a job and a schedule, a migration, and one contribution to each slot (an account-menu item `adminOnly`, and a tenant-conditional banner).

  Contract tests assert each behavior, a throwing contribution, and the cross-origin POST refusal. Document the plugin API with the sample plugin as the example.

  Verify: `pnpm test:contract` passes, including the static public-import check.

## 12. Public surface, versioning and release

- [x] 12.1 Finalize the `exports` maps:
  - `@docmyrepos/core` `.`;
  - `@docmyrepos/server` `.`, `./proxy` and `./next`;
  - `@docmyrepos/ui` `./pages` and `./styles.css`;
  - `./internal/*` on each, documented as non-semver.

  Add `tsconfig.build.json` per package and a `pnpm build:packages` script.

  Verify: `pnpm build:packages` emits JS and `.d.ts`, the `"use client"` directives survive in `dist`, and `pnpm pack` per package followed by installation into a temp project with `tsc --strict` compiles the documented host example.
- [x] 12.2 Add `scripts/api-report.ts` (TypeScript compiler API) and the checked-in `packages/*/api-report.json`, plus `pnpm api:check`.

  Verify: `pnpm api:check` passes, and fails naming an export added without a report update (reverted).
- [x] 12.3 Add `@changesets/cli` (dev) with `fixed` versioning over the root and the three packages, a `scripts/sync-installer-version` step for `install.sh`, and extend `scripts/check-release-versions.sh` to the packages. Document the changeset workflow in `CONTRIBUTING.md`.

  Verify: `pnpm changeset version` on a test changeset bumps all four `package.json` files and `install.sh` together (reverted), and the check script fails on a mismatched package version.
- [x] 12.4 Update CI (`ci.yml`): add `pnpm test:contract` (with Postgres), `pnpm api:check` and `changeset status --since=origin/main` for PRs that touch `packages/**`.

  Verify: run the jobs locally with the same commands, and confirm a PR without a changeset fails the status step.
- [x] 12.5 Update the release workflow (`release.yml`): a `packages` job after `ci`, repository-guarded, `id-token: write`, an `npm view` refusal for an existing version, and `pnpm -r publish --provenance --access public`. The image job is unchanged.

  Verify: `actionlint` (or the existing workflow lint) passes, and a dry run (`pnpm -r publish --dry-run`) lists exactly the three packages with `dist` only.

## 13. Integration verification

- [x] 13.1 Run the full gates on a clean checkout: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm test:contract && pnpm api:check && pnpm build && pnpm test:e2e`, plus `openspec validate --all`.

  Verify: all green.
- [x] 13.2 Run the upgrade-in-place check:
  1. Start the previous release's image on a database, create an admin, enter the settings and secrets, upload a logo, and sign in.
  2. Switch to the new image with the same `.env`.

  Confirm the session still works, the secrets decrypt, the logo is served, there was no migration diff, and the start-up log event names and fields are the same. Roll back to the old image and confirm it still works.

  Verify: record the steps and results in the PR description.
- [x] 13.3 Run the self-host smoke test: `install.sh` in preview mode and `docker compose up -d --build --wait` with an unchanged `.env.example`-derived `.env`.

  Verify: `/api/health` answers 200, `/status` names the same missing settings as before, and `README.md` self-host instructions need no edit (or note only the contributor-facing package layout in the development section).

## Workflow follow-up

- Run `/opsx:archive` after review to sync the deltas into `openspec/specs/`.
- Maintainer (owner of the `@docmyrepos` npm scope): before the first tagged release, register a trusted publisher on npmjs.com for `@docmyrepos/core`, `@docmyrepos/server` and `@docmyrepos/ui`, with repository `Dash-AI-Tools/doc-my-repos`, workflow `release.yml` and environment `release`. npm requires a package to exist before trusted publishing is configured, so the first publish of each package may have to be made by hand.
