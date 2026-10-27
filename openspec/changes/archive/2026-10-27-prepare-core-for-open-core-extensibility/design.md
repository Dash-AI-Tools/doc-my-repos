# Design

## Context

See `proposal.md` for the motivation. This section records the current state, analysed before planning, that the decisions below depend on.

### Entrypoints, bootstrap and configuration

- **Next.js file routes.** There are 58 `page.tsx`, `layout.tsx` and `route.ts` files under `src/app/`. They are already thin:
  - Pages call a `src/server/*` loader such as `loadHome` or `loadDocPage`, branch on its `status` and render `src/components/*`.
  - Route handlers wrap a `src/server/*` handler and declare `dynamic = "force-dynamic"` and `runtime = "nodejs"`.

  Handlers take a `deps` object with production defaults, for example `HomeDeps.db?: () => Db` and `handleManualSync(request, { readSecret, getService })`. That is the codebase's existing injection idiom.
- **`src/instrumentation.ts`.** In the Node runtime only, it:
  - validates the environment (`parseEnv`);
  - checks the encryption key (`parseEncryptionKey`);
  - warns about retired variables (`retiredSources`);
  - calls `bootSyncScheduler({ getRuntime: () => getWorkspace() })`.
- **`src/proxy.ts`.** Edge runtime. It handles percent-escape errors, the CSP nonce and the security headers. It also checks the session cookie signature and expiry with WebCrypto (`edge-session.ts`). Its public paths are a hard-coded `isPublicPath` list.
- **Startup configuration.** `src/server/config/env.ts` reads `DATABASE_URL`, `SYNC_SECRET`, `SESSION_SECRET`, `ADMIN_EMAIL`/`ADMIN_PASSWORD` and `LOG_LEVEL`. `SETTINGS_ENCRYPTION_KEY` is read in `settings/crypto.ts`, and `SYNC_SCHEDULER`/`NODE_ENV` in `schedule-runtime.ts`. Test switches are `E2E_FIXTURES` and `E2E_AUTH_BYPASS`.
- **Workspace settings.** These are the GitHub App, repository scope, limits and providers. `createWorkspace` builds them from the `workspace_settings` row and the decrypted `workspace_secrets`. `getWorkspace()` caches the result once per process on `globalThis`, re-checks the settings version every 5 s, and shares a single in-flight build.
- **Migrations.** `scripts/db-migrate.ts` is bundled to `dist/db-migrate.mjs` and run by `docker-entrypoint.sh`. `migrateDatabase` takes the advisory lock `docmyrepos:migrate/schema`.

### Where infrastructure is wired (★ = hard-coded)

| Concern | Wiring today |
|---|---|
| Auth | ★ The session is an HMAC cookie `dmr_session {uid, role, exp, pwv}`.<br>★ `getCurrentUser()` reads `next/headers` implicitly, re-checks the DB row, and is not memoized per request.<br>MCP uses SHA-256-hashed API tokens. `SYNC_SECRET` guards `/api/sync`, and an HMAC signature guards webhooks. |
| Authorization | ★ About 15 inline `role === "admin"` and ownership checks: admin `guard()`/`adminOrDenied`/`requireAdmin`, the admin layout, comments `mayModify` and resolve, author-email visibility, the token API and the onboarding banner.<br>★ Client components repeat the rules (`comment-item.tsx`, `account-menu.tsx`).<br>Repository visibility is one filter in `src/server/queries/visibility.ts`. |
| Persistence | ★ `getDb()` is a `globalThis` singleton from `DATABASE_URL`. The query layer takes `db` explicitly, but 27 entry modules fall back to `getDb()`. |
| Background jobs | ★ No queue. In-process `setTimeout` loops (`scheduler.ts`, `schedule-runtime.ts`) start at instrumentation. Webhook work is a detached promise in a `globalThis` task set. Serialization uses Postgres advisory locks plus `repos.sync_requested_at` as a rerun marker (ADR 0002). |
| Email | None. The app sends no mail. |
| Secrets | ★ AES-256-GCM, with the key derived (HKDF) from `SETTINGS_ENCRYPTION_KEY`. `process.env` is read directly in `workspace.ts`, `admin/settings.ts` and `instrumentation.ts`. |
| Blob storage | ★ The branding logo is `site_branding.logo` (`bytea`). `/api/asset` fetches images live from GitHub into a per-process LRU. Nothing is written to disk. |
| External APIs | ★ The GitHub client is built only inside `createWorkspace` and `settings/github-test.ts`. The LLM providers are a two-way switch. |

### Implicit single-tenant assumptions

- **Schema.** No table has a tenant column. `workspace_settings`, `site_branding` and `ask_settings` are `CHECK (id = 1)` singletons. The `repos`, `users` and `repo_folders` unique keys are global.
- **Process state on `globalThis`.**
  - The DB handle and the workspace (cache plus in-flight build).
  - The scheduler, once per process.
  - The webhook task set.
  - The asset cache and the asset fetch gate.
  - The MCP limiter.
  - Module scope also holds `askGate` (keyed by user id) and the concurrency counters in `search-api` and `status-api`.
- **Keys that would collide across tenant databases.** User ids (`askGate`, sessions), token ids (MCP limiter) and `githubId` (the asset cache key `githubId/branch/path`).
- **Locks.** Advisory lock keys are `docmyrepos:<ns>` plus an id. Postgres scopes advisory locks to the current database (the lock tag includes the database OID). With one database per tenant they therefore never collide, and need no change.
- **Jobs and webhooks.** Job payloads are in-process function arguments (`SyncAllOptions`, `SyncOneTarget`). The webhook router compares `installation.id` with the one configured installation.
- **Sessions.** The session cookie carries no tenant, and `SESSION_SECRET` is process-wide.
- **Files.** Only `/tmp` and `.next/cache`. There is no app-level file path to scope.

### UI areas where external code needs to inject content

All of these are hard-coded lists today:

- **Header nav** (`site-header.tsx`, server): "Repositories", plus "Ask" behind a flag.
- **Account menu** (`account-menu.tsx`, client): the `ADMIN_LINKS`, `AGENT_ADMIN_LINK` and `AGENT_LINK` arrays.
- **Admin home sections** (`app/admin/page.tsx`): a literal `<ul>` that duplicates part of the account menu.
- **Workspace tabs** (`app/admin/workspace/page.tsx`): a literal `tabs` array. The generic `Tabs` client component already takes `{id, label, panel}`.
- **Footer** (`site-footer.tsx`): credit, star and "Sync status" links.
- **Banners.** There is no global banner area. `SetupBanner` renders only on the home page and the admin home.

### Constraints that shape the approach

- **Next.js App Router owns routing at build time.** Routes, pages and React components cannot be loaded into a prebuilt server at runtime.
- **The proxy runs in the Edge runtime.** It cannot reach the database or Node-only code, so hooks that touch the database run in Node.
- **The SaaS layer is multi-tenant with one database per tenant**, served by a shared application tier (user decision for this change).

## Goals / Non-Goals

**Goals:**
- One composition root, where every extension point is a typed argument.
- Behavior identical for the built-in tenant, including cookies, log lines, URLs, timings and data.
- A tenant database chosen per request and per job, so one process serves many tenant databases.
- A public package surface small enough to keep stable under semver.

**Non-Goals:**
- **Row-level isolation in a shared database.** That means no tenant column, no tenant predicate in queries and no lock namespacing. The "Future: shared database" notes under Decision 8 say where each would go.
- **Running plugins in the prebuilt container image without a build.** A host app builds its own image.
- **Replacing Postgres or Drizzle.** The database adapter selects a database; it does not abstract over engines.
- **New product features.** That includes quantity-based entitlements, an audit-log UI and email features.

## Decisions

### 1. Host-app composition, not runtime plugin loading

The external layer is a Next.js **host app** that depends on the packages and owns its own `app/` directory of thin files. It mirrors the OSS app and adds its own routes. It passes its hooks, adapters and plugins to `createApp` in one module. This is the pattern Payload CMS uses on Next.js.

The OSS repo's root app is the reference host: it uses the defaults and is what the container image ships.

Alternatives rejected:
- **Loading plugins into the prebuilt image at runtime.** Next bundles routes, server components and client components at build time. Runtime `import()` of arbitrary code also skips type checking and the CSP model.
- **A SaaS service in front that proxies to the core.** It cannot change permission checks, add UI or see domain events without patching, and it doubles authentication.
- **Forking.** Excluded by the constraints.

Consequence: the core image stays the OSS image. The SaaS repo builds its own image from its host app, using the same Dockerfile pattern. It runs `migrateDatabase` from `@docmyrepos/server` once per tenant database.

### 2. The application object and the request context

`createApp()` returns:

```ts
interface App {
  readonly apiVersion: number;                       // EXTENSION_API_VERSION
  start(): Promise<void>;                            // instrumentation register()
  routes: Record<RouteName, RouteHandlers>;          // { GET?, POST?, … } per core API route
  context(request: Request): Promise<RequestContext | null>; // null = unknown tenant (404)
  pageContext(): Promise<RequestContext | null>;     // server components; React cache() per request
  jobs: { run(job: Job): Promise<void> };            // executes a job by name (host workers call this)
  slots: { resolve<S extends SlotName>(slot: S, ctx: RequestContext): Promise<SlotItems<S>> };
  migrate(target: { tenant: TenantContext } | { url: string }): Promise<void>;
}

interface RequestContext {
  readonly tenant: TenantContext;
  readonly log: Logger;                              // child logger; `tenant` field only when not "default"
  db(): Promise<Db>;                                 // via the database adapter, per tenant
  workspace(): Promise<Workspace>;                   // per-tenant cache
  user(): Promise<User | null>;                      // authenticate(), memoized for the request
  can(action: Action, resource?: Resource): Promise<boolean>; // authorize(), fails closed
  entitled(feature: Feature): Promise<boolean>;      // checkEntitlement(), fails closed
  emit(event: DomainEventInput): void;               // fire-and-forget to onEvent
  adapters: Pick<Adapters, "blobs" | "email" | "jobs">;
}
```

- **Threading.** The context is passed explicitly. Services that take `deps` today gain a `ctx` field, and the 27 `getDb()` fallbacks become `ctx.db()`. AsyncLocalStorage was rejected because it hides the dependency, breaks the existing deps-injection test style, and is unreliable across the RSC/SSR boundary.
- **Pages.** `pageContext()` builds a `Request` view from `headers()` and the pathname. The proxy forwards the pathname in an internal `x-dmr-pathname` request header, overwriting any value the client sent. The result is memoized with React `cache`.
- **Process state.** Next can evaluate the application module more than once per process: in the instrumentation, route and RSC layers. All process state therefore stays in one `globalThis` registry under `Symbol.for("docmyrepos.runtime")`, as `getDb`/`getWorkspace` do today: per-tenant workspaces, the scheduler, task sets, caches and limiters. `createApp` itself is cheap and deterministic.
- **Route segment config.** Next statically reads `dynamic`/`runtime`, so route files keep those as literal exports and re-export only the handlers and components:

  ```ts
  // src/app/api/sync/route.ts
  import { app } from "@/docmyrepos";
  export const dynamic = "force-dynamic";
  export const runtime = "nodejs";
  export const { POST, GET, PUT, PATCH, DELETE } = app.routes.sync;
  ```

  ```ts
  // src/app/page.tsx
  import { app } from "@/docmyrepos";
  import { HomePage, bindPage } from "@docmyrepos/ui/pages";
  export const dynamic = "force-dynamic";
  export default bindPage(HomePage, app);
  ```
- **Config.** `config` is the validated startup configuration (`EnvConfig` plus the scheduler mode and the encryption-key variable). The default is `loadConfig(process.env)`, which uses the same zod rules, so messages and env vars are unchanged.

### 3. Hooks: signatures, versioning, defaults, failure

```ts
interface Hooks {
  resolveTenant(request: Request): Promise<TenantContext | null>;
  listTenants(): Promise<readonly TenantContext[]>;
  authenticate(request: Request, tenant: TenantContext): Promise<User | null>;
  authorize(ctx: RequestContext, action: Action, resource: Resource): Promise<boolean>;
  checkEntitlement(ctx: RequestContext, feature: Feature): Promise<boolean>;
  onEvent(event: DomainEvent): void | Promise<void>;
}
```

- **Versioning.** `EXTENSION_API_VERSION = 1` (in `@docmyrepos/core`) covers hooks, actions, features, events, adapters, slots and plugins together. Plugins declare `apiVersion`, and `createApp` refuses another major. Using a single number avoids version matrices across the contracts.
- **Defaults.** `defaultHooks` is exported so a host can wrap rather than reimplement. For example, `authenticate` can try SSO first and fall back to `defaultHooks.authenticate`.
- **Failure handling** sits in one `invokeHook` wrapper:
  - A throw or rejection from `resolveTenant`, `authenticate`, `authorize` or `checkEntitlement` becomes deny, plus one `hook.failed` warning naming the hook.
  - `onEvent` errors are logged by event name only.
- **`listTenants`** was added to the requested set. With one database per tenant, the scheduler cannot find tenants any other way, and it costs one default function.

### 4. One authorization policy, with today's rules as the default

`defaultAuthorize(user, action, resource)` is a pure function in `@docmyrepos/core`, unit-tested against the current rules:

| Action | Default rule (today) | Resource |
|---|---|---|
| `admin.manage` | role `admin` | `{ kind: "workspace" }` |
| `content.read` | signed in | `{ kind: "workspace" }` |
| `ask.use` | signed in | — |
| `comment.create` | signed in | `{ kind: "document" }` |
| `comment.create_as_organization` | admin | document |
| `comment.edit`, `comment.delete` | organization comment → admin; otherwise author | `{ kind: "comment", authorId, asOrganization }` |
| `comment.resolve` | author or admin | comment |
| `comment.moderate` | admin | comment |
| `comment.view_author_email` | admin | — |
| `token.manage_own` | signed in | `{ kind: "token", ownerId }` |
| `token.manage_any` | admin | token |

- **Call sites.** Every inline check becomes `ctx.can(...)`. `requireAdmin`/`guard`/`adminOrDenied` keep their HTTP behavior (401/403/"Access denied") but ask `can("admin.manage")`.
- **Invariants stay in core.** The user-management invariants (no self-demotion, the last admin) stay after `can()` as data invariants. The visibility filter stays the only repository filter.
- **Client components** (`comment-item`, `account-menu`) stop repeating role rules. They receive server-computed booleans or items as props, so a host's policy is reflected in the UI too.

### 5. Entitlements reuse the existing "off" switches

There are already single decision points for each switchable feature: `getAskState` (Ask), `mcpEnabled` (MCP) and `commentsEnabled` (comments). Each becomes `setting && ctx.entitled(feature)`. Every surface that honours the admin switch then honours the entitlement too, with no new UI states. Plugins call `ctx.entitled("their-feature")`. Feature is `CoreFeature | (string & {})`.

### 6. Events are emitted after commit and never awaited

- **Emission.** `ctx.emit()` stamps the name, `schemaVersion: 1`, the tenant id, `at` and the actor. It then calls `onEvent` inside a detached promise with a catch, never awaited by the action. Calls sit after the transaction or the decided result, at the points listed in the spec's event catalogue.
- **Payloads.** Each payload type is declared in core (ids and counts only). A unit test feeds sentinel content through each emitting path and asserts that it never appears in an event, reusing the `log-sentinel` approach.
- **`after()` rejected.** Next's `after()` would tie `src/server` to Next request scope and would not work in jobs.

### 7. Adapter contracts

```ts
interface DatabaseAdapter { forTenant(t: TenantContext): Promise<DbHandle>; close(): Promise<void> }
interface SecretsAdapter  { encryptionKey(t: TenantContext): Promise<EncryptionKeyResult> }
interface BlobStore {
  get(t: TenantContext, name: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  put(t: TenantContext, name: string, blob: { bytes: Uint8Array; contentType: string }): Promise<void>;
  delete(t: TenantContext, name: string): Promise<void>;
}
interface EmailAdapter { send(t: TenantContext, message: EmailMessage): Promise<void> }
interface JobsAdapter  { submit(job: Job): Promise<{ done?: Promise<void> }> }  // Job = { name, tenantId, payload }
```

Defaults are today's code, moved behind the interfaces:

- **Database.** `getDb()` for `default`, and a `ConfigError` for any other tenant.
- **Secrets.** `parseEncryptionKey(process.env.SETTINGS_ENCRYPTION_KEY)`, so the ciphertext format and `keyVersion` 1 are unchanged. The three direct `process.env` reads go away.
- **Blobs.** `branding/logo` maps to the existing `site_branding.logo`/`logo_type` columns, so no data moves. `logoVersion` (cache busting) stays in the row. Other names reject as unsupported; no generic blob table is invented without a core use.
- **Email.** Rejects with `EmailNotConfiguredError`. Core has no call sites. The adapter exists because the requested plugin features (invites, signup) need one transport seam that a host configures once.
- **Jobs.** `submit` runs the job in-process at once, tracks it in the existing background task set, and returns `done`. Webhooks keep the "wait up to 5 s for `done`, then 202" behavior. With a durable host queue `done` is absent and the answer is 202 at once.

**Jobs.** Core registers the jobs `sync.full`, `sync.repo`, `sync.drain`, `sync.reap` and `webhook.dispatch`, with JSON payloads that always include `tenantId`. `app.jobs.run(job)` resolves the tenant context (by `listTenants()` id, or an id in the payload) and runs the registered handler. Syncs stay serialized by the existing advisory locks and `sync_requested_at` coalescing, which work whatever runs the job (ADR 0002). Manual `POST /api/sync` stays synchronous in the request, because its response reports the sync result.

**Migrations.** `migrateDatabase(url, { plugins })` keeps the current core path and lock. `scripts/db-migrate.ts` calls it with `DATABASE_URL` and no plugins, so the command, image and messages are unchanged.

### 8. Tenant model

- **Tenant id.** `TenantContext = { id: string; attributes: Readonly<Record<string, unknown>> }`. The id matches `^[a-z0-9][a-z0-9-]{0,62}$`, and the built-in tenant is `{ id: "default", attributes: {} }`.
- **Partitioned state.** The workspace cache becomes a per-tenant map, bounded LRU with a fixed cap that is 1 in practice for OSS. `invalidateWorkspace(tenant)` drops one tenant. The asset cache key gains a `tenantId/` prefix. The `askGate` and MCP limiter keys become `tenantId:id`. The scheduler keeps one loop per listed tenant, reconciled on each drain tick.

  These stay shared: the asset fetch gate and the `search`/`status` concurrency counters, which are process protections, and Shiki.
- **Sessions.**
  - `SessionPayload` gains an optional `tid`. It is written only for tenants other than `default`, so OSS cookies stay byte-for-byte the same format.
  - Older releases ignore an extra field, so rollback is safe.
  - Verification requires `tid === tenant.id`, with a missing `tid` meaning `default`.
  - `issueSession(ctx, user)` is public, so a host SSO plugin can issue core sessions after its own flow and the default `authenticate` and Edge gate keep working.
- **Authentication in Node on every gated request.** The Edge proxy cannot resolve tenants, so it only pre-checks the signature. Every gated page and API therefore calls `ctx.user()`. Today the content pages skip this, and `current-user.ts` already calls the database check "the source of truth". Doing it everywhere is what makes tenant-bound cookies safe. It also closes the disabled-user gap, at the cost of one primary-key lookup per request, memoized. This is the behavior tightening the proposal calls out.
- **Webhooks.** `resolveTenant` receives the raw `Request`. A host may read a clone of the body, for example `installation.id` for a shared GitHub App. The core then verifies the HMAC with that tenant's workspace secret, and the router's existing installation check rejects a mismatch.
- **Logs.** `ctx.log` is `logger.child({ tenant })` only for tenants other than `default`, so OSS log lines are unchanged.
- **Instance-per-tenant.** This already works with the defaults: one `DATABASE_URL` per instance.
- **Future: shared database** (not now). Three things would change:
  - A tenant predicate in `visibleRepos()` and the few non-repo reads in the query layer: settings, users, tokens, folders, runs and usage.
  - A tenant column in the schema.
  - A tenant id inside every `advisoryLockKey` namespace.

  The context already reaches all of these places.

### 9. Plugin routing and isolation

- **API routes.** `src/app/api/plugins/[plugin]/[...path]/route.ts` dispatches to the registry and answers 404 or 405 before any plugin code runs.
- **Pages.** `src/app/-/[plugin]/[[...path]]/page.tsx` renders inside the root layout. `-` cannot be a GitHub login, because logins cannot start with a hyphen. A static segment also beats `[owner]` in Next's matching. `-` is added to `RESERVED_OWNERS` anyway.
- **Public routes by path convention.** The Edge proxy passes `^/-/[^/]+/public(/|$)` and `^/api/plugins/[^/]+/public(/|$)` without needing the plugin list, which is not available at the edge. The dispatcher then serves only routes that were declared public.
- **Host proxy options.** `createProxy({ publicPaths, isSignedIn? })` lets a host add its own public routes, such as `/pricing`. It can also replace the Edge cookie pre-check if it uses a different session mechanism.
- **Writes.** Unsafe methods run the existing `requireSameOrigin` unless the route is declared `machine: true`.
- **Migrations.** Each plugin's SQL runs after the core migrations, in schema `plugin_<id>`, with its own Drizzle journal table there (`migrationsSchema`/`migrationsTable`), one transaction per plugin and `SET LOCAL search_path`. Before and after, the runner fingerprints the core `public` schema: tables, columns, constraints and indexes from `information_schema`/`pg_catalog`. Any difference rolls back and fails with the plugin's id. This enforces "never modify core tables" without database roles.

### 10. UI slots

- **Slot types.** Typed in `@docmyrepos/core`:

  | Slot | Contribution shape |
  |---|---|
  | `header.nav`, `footer.links`, `account.menu` | `{ href, label }` data items (plus `adminOnly` for `account.menu`) |
  | `admin.sections` | `{ href, label, description }` |
  | `admin.workspace.tabs` | `{ id, label, render(ctx) }` |
  | `layout.banner` | `render(ctx) → ReactNode \| null` |

- **Core items** are registered as the first contribution of each slot, in today's order. That removes the duplicated admin lists while keeping the items each place shows today. `app.slots.resolve` evaluates contributions per request, drops a throwing one with a `plugin.failed` warning, and returns serializable data for the client `AccountMenu`.
- **Rendering.** `@docmyrepos/ui` renders the slots. `layout.banner` sits in the root layout above `<main>`. Server-side `render` functions keep plugin React code in the server bundle unless the plugin passes its own client component.

### 11. Packages and public surface

```
packages/core    @docmyrepos/core    ← src/lib/** + src/server/config/schema.ts (pure zod) + new contracts
packages/server  @docmyrepos/server  ← src/server/** (depends on core)
packages/ui      @docmyrepos/ui      ← src/components/** + page/layout bodies from src/app (depends on core, server)
/ (root app)     docmyrepos (private) ← src/app thin files, src/docmyrepos.ts, src/instrumentation.ts, src/proxy.ts
```

- **Folder structure.** The folder structure inside each package mirrors today's tree (`server/sync`, `server/queries`, …), so history (`git mv`) and existing docs references survive. The dependency direction is `core ← server ← ui ← app`. Existing leaks are allowed by this direction: components importing server types and the `setNavView` server action, and `lib/settings-form.ts` using the config schema type, which moves into core.
- **Public entrypoints.**

  | Package | Entrypoints |
  |---|---|
  | `@docmyrepos/core` | `.` (contracts, constants, `definePlugin`, `defaultAuthorize`) |
  | `@docmyrepos/server` | `.` (`createApp`, `defaultHooks`, default adapters, `migrateDatabase`, `issueSession`), `./proxy` (Edge-safe `createProxy`), `./next` (`withDocMyRepos`) |
  | `@docmyrepos/ui` | `./pages`, `./styles.css` |

  Cross-package needs go through `./internal/*` subpaths. Those are documented as not covered by semver, which is safe only because versions are lockstep.
- **Development.** Package `exports` point at `src/*.ts` inside the workspace, with `publishConfig.exports` pointing at `dist`, and the app uses `transpilePackages`. Vitest and tsc resolve the sources directly, and `@/` aliases inside packages become relative imports.
- **Publish build.** `tsc -p tsconfig.build.json` per package emits JS and `.d.ts`, keeping `"use client"` directives. `@docmyrepos/ui/styles.css` carries `@source` for its `dist` so a host's Tailwind v4 scans it.
- **Next.js helper.** `withDocMyRepos(nextConfig)` moves today's `next.config.ts` contents into a reusable helper: the swagger Turbopack alias, the static headers, the standalone opt-in and `transpilePackages`.
- **API report.** `scripts/api-report.ts` uses the TypeScript compiler API, already a dependency, to list each public entrypoint's exported names and kinds into `packages/<pkg>/api-report.json`, and CI diffs it. API Extractor was rejected because a short script covers the need without a new tool.
- **Enforcement test.** The table-access guard (`enforcement.test.ts`) is updated to the new paths, and keeps its meaning.

### 12. Versioning, changelog and release

- **Changesets.** `@changesets/cli` is a dev tool, not a framework, used in `fixed` mode across `docmyrepos` (private, versioned) and the three packages. `changeset version` updates every `package.json` and the changelogs. `install.sh`'s version is bumped in the same step through a small script, and `scripts/check-release-versions.sh` now checks the packages as well.
- **CI.** PRs run `changeset status --since=origin/main` when package sources change.
- **Release.** `release.yml` gains a `packages` job after `ci`. It runs with `id-token: write` (npm trusted publishing, no token) and `pnpm -r publish --provenance`. A `npm view` pre-check refuses an existing version. The tag trigger, the image job and its gating are unchanged.
- **Dockerfile.** The `deps` stage copies `packages/*/package.json` before `pnpm install --frozen-lockfile`. The build is otherwise identical, and so are runtime stages, labels, entrypoint, user, healthcheck and `MIGRATIONS_DIR`.

### 13. Contract suite

- **Layout.** `tests/contract/` holds a sample host module (`host.ts`) and a sample plugin (`sample-plugin/`, its own workspace package that depends only on public exports). It runs as a Vitest project, `pnpm test:contract`, which `pnpm test` also includes.
- **Test databases.** `createTestDatabase()` is called twice, giving tenants `a` and `b`, wired through a stub `DatabaseAdapter`.
- **Stubs.** The hooks are a header-based `resolveTenant`, a stub `authenticate`, a deny-list `authorize`, a toggle `checkEntitlement` and a recording `onEvent`. There is also an in-memory blob store, a recording email adapter and a queue jobs adapter that the test drains through `app.jobs.run`.
- **How it tests.** Calls go through `app.routes.*` with real `Request` objects, `app.jobs.run` and `app.slots.resolve`. The plugin's route, page, job, schedule, migration and slots are each asserted. A static test parses every import in `tests/contract/**` and fails on anything other than a public entrypoint. The suite grows with each task group, so each group lands its own contract tests.

### 14. Order of work

1. The package move goes first, as a pure mechanical step, so every later change, and the contract suite, already uses the final layout and public imports.
2. `createApp` and the thin route files follow, bound to the unchanged services.
3. Each seam is then cut in its own group: tenant context and database, authentication, authorization, entitlements, events, the secrets/blob/email adapters, then jobs.
4. Plugins come last, because they consume every seam.

Each task ends with typecheck, lint, unit tests and the relevant e2e specs green.

## Risks / Trade-offs

- **[Large mechanical move breaks imports or e2e.]** → `git mv` plus a codemod for the `@/` imports, in a dedicated task with no behavior change. The gate is `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` and a Docker build.
- **[Next route segment config or the `/-/` segment behaves unexpectedly.]** → Literal `dynamic`/`runtime` exports stay in route files. The `-` catch-all is proven by an e2e spec before plugin pages build on it.
- **[Several app instances per process (separate Next bundles).]** → All state lives in one `globalThis` registry. A test creates two apps and asserts one scheduler and one workspace cache.
- **[An extra DB lookup per page from Node-side authentication.]** → A primary-key lookup memoized per request. This is accepted, because it is required for tenant-bound sessions and fixes the disabled-user gap.
- **[A slow or hanging `onEvent` accumulates pending promises.]** → Delivery is detached and never awaited, and the host owns its hook's latency. This is documented in the extension reference, and a contract test shows a hanging hook does not slow responses.
- **[Internal subpaths leak into host code.]** → The contract suite's static check, the API report and the docs. Lockstep versions keep core-internal cross-package use consistent.
- **[A plugin migration damages core tables.]** → Each runs in its own schema and transaction, with the core-schema fingerprint check and rollback.
- **[Per-tenant connection pools exhaust Postgres.]** → Owned by the host's database adapter. The core creates pools only in the default adapter. The adapter docs state the need for a bounded pool cache.
- **[The Edge gate cannot see host sessions.]** → `issueSession` lets a host's SSO produce core sessions, and `createProxy({ isSignedIn })` can replace the pre-check.
- **[npm trusted publishing is not yet configured at the first release.]** → The maintainer owns the `@docmyrepos` scope. Before the first tagged publish, they register each package's trusted publisher on npmjs.com: repository `Dash-AI-Tools/doc-my-repos`, workflow `release.yml`, environment `release`. Until that is done, the `packages` job fails before publishing, and the image job is independent.

## Migration Plan

- **Deploy.** A normal release: there is no schema migration, configuration change or data change, and existing cookies and secrets stay valid.
- **Rollback.** Redeploy the previous image. The database is untouched. Cookies written for `default` keep the old format, and older releases ignore an unknown `tid` in any case.
- **Release order.** The packages and the image publish from the same tag. A host app pins the exact version of all three packages.
- **Verification before release.** Start the new build against a database populated by the previous release. Check that a session, stored secrets and the uploaded logo survive, and that the log lines carry the same fields (task 13.2).

## Open Questions

- Whether the SaaS layer will later want quantity-based entitlements (for example a repository cap). That could be an optional hook added in a minor release without breaking `checkEntitlement`.
